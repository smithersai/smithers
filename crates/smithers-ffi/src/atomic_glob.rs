//! The same bounded glob grammar for every native filesystem backend.
use std::io;

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

struct GlobAlternative {
    pattern: String,
    matcher: globset::GlobMatcher,
    directory_only: bool,
    root_only: bool,
    dot_anchor: bool,
    trailing_globstar: bool,
    literal_core: bool,
    anchor_matcher: Option<globset::GlobMatcher>,
    impossible_dot_segment: bool,
}
pub(super) struct GlobRule {
    alternatives: Vec<GlobAlternative>,
    anchor: bool,
}
impl GlobRule {
    pub(super) fn new(pattern: &str, anchor: bool) -> io::Result<Self> {
        if pattern.len() > 4096 || unsupported_glob(pattern) {
            return Err(invalid("unsupported glob pattern"));
        }
        let mut alternatives = Vec::new();
        for expanded in expand_braces(pattern)? {
            alternatives.push(GlobAlternative::new(&expanded)?);
        }
        Ok(Self {
            alternatives,
            anchor,
        })
    }
    pub(super) fn matches(&self, path: &str, is_directory: bool) -> bool {
        self.alternatives
            .iter()
            .any(|rule| rule.matches(path, is_directory, self.anchor))
    }
    pub(super) fn includes_root(&self) -> bool {
        self.alternatives.iter().any(|alt| alt.root_only)
    }
    pub(super) fn below(&self, path: &str) -> bool {
        self.alternatives.iter().any(|rule| rule.below(path))
    }
}
impl GlobAlternative {
    fn new(pattern: &str) -> io::Result<Self> {
        let directory_only = pattern.ends_with('/');
        let trimmed = pattern.trim_end_matches('/');
        let dot_anchor = trimmed == "[.]" || trimmed.ends_with("/[.]");
        let impossible_dot_segment = pattern.contains("[.]/");
        let mut parsed = trimmed.replace("[.]", ".");
        while parsed.contains("//") {
            parsed = parsed.replace("//", "/");
        }
        let parsed = parsed.trim_start_matches("./");
        let parsed = if dot_anchor {
            parsed.trim_end_matches("/.").to_owned()
        } else {
            parsed.to_owned()
        };
        let parsed = parsed.trim_end_matches('/');
        let root_only = parsed.is_empty() || parsed == ".";
        let trailing_globstar = parsed == "**" || parsed.ends_with("/**");
        let core = if trailing_globstar {
            parsed.strip_suffix("/**").unwrap_or("")
        } else {
            parsed
        };
        let literal_core = !core.contains(['*', '?', '[', '{']);
        let mut escaped = parsed.replace('{', "\\{").replace('}', "\\}");
        if parsed.matches('[').count() != parsed.matches(']').count() {
            escaped = escaped.replace('[', "\\[");
        }
        let escaped = if escaped.is_empty() {
            ".".to_owned()
        } else {
            escaped
        };
        let matcher = globset::GlobBuilder::new(&escaped)
            .literal_separator(true)
            .backslash_escape(true)
            .empty_alternates(true)
            .build()
            .map_err(|_| invalid("glob pattern"))?
            .compile_matcher();
        let anchor_matcher = if trailing_globstar && !core.is_empty() {
            Some(
                globset::GlobBuilder::new(core)
                    .literal_separator(true)
                    .build()
                    .map_err(|_| invalid("glob anchor"))?
                    .compile_matcher(),
            )
        } else {
            None
        };
        Ok(Self {
            pattern: parsed.to_owned(),
            matcher,
            directory_only,
            root_only,
            dot_anchor,
            trailing_globstar,
            literal_core,
            anchor_matcher,
            impossible_dot_segment,
        })
    }
    fn matches(&self, path: &str, is_directory: bool, anchor: bool) -> bool {
        if self.impossible_dot_segment {
            return false;
        }
        if self.dot_anchor
            && (!anchor
                || !(is_directory || self.literal_core)
                || self.pattern == "**"
                || self.pattern.ends_with("/**"))
        {
            return false;
        }
        if !anchor
            && self.trailing_globstar
            && self
                .anchor_matcher
                .as_ref()
                .is_some_and(|matcher| matcher.is_match(path))
        {
            return false;
        }
        (!self.directory_only || is_directory)
            && (if path.is_empty() {
                anchor && (self.root_only || self.pattern == "**" || self.pattern == "**/**")
            } else {
                !self.root_only
                    && (self.matcher.is_match(path)
                        || (anchor
                            && self.trailing_globstar
                            && (is_directory || self.literal_core)
                            && self
                                .anchor_matcher
                                .as_ref()
                                .is_some_and(|matcher| matcher.is_match(path)))
                        || (self.dot_anchor && self.pattern == path))
            })
            && (path.is_empty()
                || !path.split('/').any(|part| {
                    part.starts_with('.')
                        && !self
                            .pattern
                            .split('/')
                            .any(|segment| segment.starts_with('.'))
                }))
    }
    fn below(&self, path: &str) -> bool {
        if self.impossible_dot_segment {
            return false;
        }
        if self.root_only {
            return false;
        }
        if path.is_empty() {
            return true;
        }
        let mut pieces = self.pattern.split('/');
        for part in path.split('/') {
            let Some(pattern) = pieces.next() else {
                return false;
            };
            if pattern == "**" {
                return true;
            }
            let Ok(glob) = globset::GlobBuilder::new(pattern)
                .literal_separator(true)
                .build()
            else {
                return true;
            };
            if !glob.compile_matcher().is_match(part) {
                return false;
            }
        }
        pieces.next().is_some()
    }
}
fn split_alternatives(body: &str) -> Option<Vec<String>> {
    let mut depth = 0;
    let mut members = Vec::new();
    let mut start = 0;
    for (index, ch) in body.char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => depth -= 1,
            ',' if depth == 0 => {
                members.push(body[start..index].to_owned());
                start = index + 1;
            }
            _ => {}
        }
    }
    if members.is_empty() {
        None
    } else {
        members.push(body[start..].to_owned());
        Some(members)
    }
}
fn expand_braces(pattern: &str) -> io::Result<Vec<String>> {
    let mut queue = vec![pattern.to_owned()];
    let mut out = Vec::new();
    while let Some(text) = queue.pop() {
        let mut stack = Vec::new();
        let mut groups = Vec::new();
        let mut expanded = false;
        for (index, ch) in text.char_indices() {
            if ch == '{' {
                stack.push(index);
            } else if ch == '}' {
                if let Some(start) = stack.pop() {
                    groups.push((start, index));
                }
            }
        }
        groups.sort_by_key(|(start, _)| *start);
        for (start, end) in groups {
            let body = &text[start + 1..end];
            if body.contains("..") {
                return Err(invalid("brace range"));
            }
            if let Some(members) = split_alternatives(body) {
                for member in members {
                    queue.push(format!("{}{}{}", &text[..start], member, &text[end + 1..]));
                }
                expanded = true;
                break;
            }
        }
        if out.len() + queue.len() > 64 {
            return Err(invalid("glob pattern expands past 64 alternatives"));
        }
        if !expanded {
            out.push(text);
        }
    }
    Ok(out)
}
fn unsupported_glob(pattern: &str) -> bool {
    if pattern.contains("[[:") {
        return true;
    }
    let mut class = false;
    let bytes = pattern.as_bytes();
    for index in 0..bytes.len().saturating_sub(1) {
        if bytes[index] == b'[' {
            class = true;
        }
        if bytes[index] == b']' {
            class = false;
        }
        if !class && bytes[index + 1] == b'(' && b"@+?!*".contains(&bytes[index]) {
            return true;
        }
    }
    false
}
pub(super) fn relative_pattern(pattern: &str, base: &str, exclusion: bool) -> String {
    if pattern.contains('\\') && !exclusion && !pattern.starts_with('/') {
        return "\0".to_owned();
    }
    let normalized = if exclusion || pattern.starts_with('/') {
        pattern.replace('\\', "")
    } else {
        pattern.to_owned()
    };
    let stripped = normalized
        .strip_prefix(base)
        .map(|value| value.trim_start_matches('/'))
        .unwrap_or(&normalized)
        .trim_start_matches("./");
    stripped.to_owned()
}
