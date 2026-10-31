---
"@smthrs/plugin": minor
---

`PluginHost.query(name, params?)` takes `QueryParams`, named string values such as the repository a view is scoped
to, and `ItemRef` carries the `params` its query was asked with. `Host.Repository`, `Host.Rendered` and `Host.pathOf`
give a `repository` view its path, `/<owner>/<name>/-/<plugin>/<path>`, and its repository; `PluginHost.open` takes
the repository a `repository` view opens on. `Load.HostFacts.slash` lists the host's own slash names, and a plugin
command naming one refuses `conflict`.
