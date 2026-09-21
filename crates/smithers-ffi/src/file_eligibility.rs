//! Private guest preflight for files written by compensable standard tools.
//! Matching stays in jj-lib; this module only supplies its native configuration
//! and ignore-file chain. It never snapshots, writes a tree, or loads op heads.
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{bail, Context};
use jj_lib::backend::{CommitId, TreeValue};
use jj_lib::default_backend_factories::{
    default_backend_factories, default_working_copy_factories,
};
use jj_lib::fileset::{self, FilesetAliasesMap, FilesetDiagnostics, FilesetParseContext};
use jj_lib::gitignore::GitIgnoreFile;
use jj_lib::matchers::{Matcher, PrefixMatcher};
use jj_lib::repo_path::{RepoPath, RepoPathUiConverter};
use jj_lib::settings::HumanByteSize;
use jj_lib::workspace::Workspace;
use pollster::FutureExt as _;
use serde::{Deserialize, Serialize};
use smithers_ffi::jj_core::{create_settings, UserConfig};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Input {
    commit_id: String,
    path: String,
    byte_length: u64,
    auto_track: String,
    max_new_file_size: String,
    fileset_aliases: String,
}

#[derive(Serialize)]
pub(super) struct Eligibility {
    eligible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
}

impl Eligibility {
    fn refuse(reason: &'static str) -> Self {
        Self {
            eligible: false,
            reason: Some(reason),
        }
    }

    fn allow() -> Self {
        Self {
            eligible: true,
            reason: None,
        }
    }
}

pub(super) fn check(repository: &Path, input: Input) -> anyhow::Result<Eligibility> {
    let repository = repository
        .canonicalize()
        .context("repository root is unavailable")?;
    let path =
        RepoPath::from_internal_string(&input.path).context("invalid repository-relative path")?;
    if path.is_root() || input.path.len() > 4096 || input.path.contains('\0') {
        bail!("expected a bounded repository-relative file path");
    }
    let parts: Vec<_> = input.path.split('/').collect();
    if parts.iter().any(|part| matches!(*part, "" | "." | "..")) || input.path.contains('\\') {
        bail!("expected a normalized repository-relative file path");
    }
    if parts
        .iter()
        .any(|part| part.eq_ignore_ascii_case(".jj") || part.eq_ignore_ascii_case(".git"))
    {
        return Ok(Eligibility::refuse("repository_metadata"));
    }

    // A tree snapshots symlink text, not the referent modified by a normal file
    // write. Refuse symlink traversal and nonregular file targets explicitly.
    let mut disk = repository.clone();
    for (index, part) in parts.iter().enumerate() {
        disk.push(part);
        match std::fs::symlink_metadata(&disk) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Ok(Eligibility::refuse("symlink_path"));
                }
                let leaf = index + 1 == parts.len();
                if (leaf && !metadata.is_file()) || (!leaf && !metadata.is_dir()) {
                    return Ok(Eligibility::refuse("nonregular_path"));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).context("cannot inspect candidate file path"),
        }
    }

    let settings = create_settings(&UserConfig::default());
    let workspace = Workspace::load(
        &settings,
        &repository,
        &default_backend_factories(),
        &default_working_copy_factories(),
    )?;
    if !PrefixMatcher::new(workspace.working_copy().sparse_patterns()?).matches(path) {
        return Ok(Eligibility::refuse("outside_sparse_snapshot"));
    }
    let store = workspace.repo_loader().store();
    if input.commit_id.len() != store.commit_id_length() * 2
        || !input
            .commit_id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        bail!("expected a full lowercase immutable commit ID");
    }
    let commit = store
        .get_commit(&CommitId::try_from_hex(&input.commit_id).context("invalid commit ID")?)?;
    let value = commit.tree().path_value(path).block_on()?;
    match value.as_resolved() {
        // JJ continues tracking existing files regardless of ignore, auto-track
        // and new-file size rules. No local pattern implementation overrides it.
        Some(Some(TreeValue::File { .. })) => return Ok(Eligibility::allow()),
        Some(None) => {}
        _ => return Ok(Eligibility::refuse("unsupported_tree_entry")),
    }
    // New ignore rules can exclude the very file being created; byte length
    // alone cannot prove its post-write eligibility. Native preparation can
    // track this file first. Existing tracked ignore files remain editable.
    if parts
        .last()
        .is_some_and(|name| name.eq_ignore_ascii_case(".gitignore"))
    {
        return Ok(Eligibility::refuse("untracked_ignore_file"));
    }

    let mut ignores = base_ignores(&repository, store)?;
    let mut parent = String::new();
    for (index, part) in parts.iter().enumerate() {
        let prefix = RepoPath::from_internal_string(&parent)?;
        ignores = ignores.chain_with_file(prefix, repository.join(&parent).join(".gitignore"))?;
        if !parent.is_empty() {
            parent.push('/');
        }
        parent.push_str(part);
        let candidate = RepoPath::from_internal_string(&parent)?;
        if index + 1 == parts.len() {
            if ignores.matches_file(candidate) {
                return Ok(Eligibility::refuse("ignored_path"));
            }
        } else if ignores.matches_dir(candidate) {
            // Native JJ does not descend into an ignored directory to find
            // child .gitignore files, so negation there cannot reinclude it.
            return Ok(Eligibility::refuse("ignored_directory"));
        }
    }

    let mut aliases = FilesetAliasesMap::new();
    let config: toml_edit::DocumentMut = input
        .fileset_aliases
        .parse()
        .context("unsupported native fileset aliases")?;
    if let Some(table) = config
        .get("fileset-aliases")
        .and_then(|item| item.as_table_like())
    {
        for (name, value) in table.iter() {
            let expression = value.as_str().context("fileset alias must be a string")?;
            aliases
                .insert(name, expression, None)
                .context("unsupported native fileset alias")?;
        }
    }
    let converter = RepoPathUiConverter::Fs {
        cwd: PathBuf::new(),
        base: PathBuf::new(),
    };
    let context = FilesetParseContext {
        aliases_map: &aliases,
        path_converter: &converter,
    };
    let matcher = fileset::parse(&mut FilesetDiagnostics::new(), &input.auto_track, &context)
        .context("unsupported native auto-track expression")?
        .to_matcher();
    if !matcher.matches(path) {
        return Ok(Eligibility::refuse("not_auto_tracked"));
    }
    let HumanByteSize(maximum) = input
        .max_new_file_size
        .parse()
        .map_err(anyhow::Error::msg)
        .context("unsupported native snapshot size limit")?;
    if maximum != 0 && input.byte_length > maximum {
        return Ok(Eligibility::refuse("new_file_too_large"));
    }
    Ok(Eligibility::allow())
}

fn base_ignores(
    repository: &Path,
    store: &Arc<jj_lib::store::Store>,
) -> anyhow::Result<Arc<GitIgnoreFile>> {
    // Same precedence as JJ's native WorkspaceCommandHelper::base_ignores:
    // core.excludesFile (or XDG default), then this backend's info/exclude.
    // gix loads the effective Git configuration without a Git subprocess.
    let backend = jj_lib::git::get_git_backend(store).context("unsupported non-Git JJ backend")?;
    let git = backend.git_repo();
    let config = git.config_snapshot();
    let exclude = match config.string("core.excludesFile") {
        Some(value) => {
            let value =
                std::str::from_utf8(&value).context("non-UTF-8 excludesFile is unsupported")?;
            Some(repository.join(jj_lib::file_util::expand_home_path(value)))
        }
        None => std::env::var_os("XDG_CONFIG_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
            .map(|home| home.join("git/ignore")),
    };
    let mut ignores = GitIgnoreFile::empty();
    if let Some(exclude) = exclude {
        ignores = ignores.chain_with_file(RepoPath::root(), exclude)?;
    }
    Ok(ignores.chain_with_file(
        RepoPath::root(),
        backend.git_repo_path().join("info/exclude"),
    )?)
}
