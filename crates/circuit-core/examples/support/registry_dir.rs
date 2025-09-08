//! Read `registry/` from disk (dev tools and tests only; the library itself does no I/O).

#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};

use circuit_core::Registry;
use circuit_core::registry::Loaded;

pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// `(file name, contents)` of every `<dir>/*.<ext>`, sorted by name.
pub fn read_docs(dir: &Path, ext: &str) -> Vec<(String, String)> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == ext))
        .collect();
    files.sort();
    files
        .iter()
        .map(|p| (p.file_name().unwrap().to_string_lossy().into_owned(), fs::read_to_string(p).unwrap()))
        .collect()
}

/// Load `<root>/manifest.yaml`, `<root>/parts/*.yaml`, `<root>/symbols/*.svg` and
/// `<root>/templates/*.yaml` through the real source loader, which also builds the sprite sheet.
pub fn load_sources(root: &Path) -> Loaded {
    #[derive(serde::Deserialize)]
    struct Manifest {
        version: String,
    }
    let manifest = fs::read_to_string(root.join("manifest.yaml")).expect("registry/manifest.yaml");
    let m: Manifest = serde_norway::from_str(&manifest).expect("manifest has a version");
    let parts = read_docs(&root.join("parts"), "yaml");
    let symbols = read_docs(&root.join("symbols"), "svg");
    let templates = read_docs(&root.join("templates"), "yaml");
    Registry::from_sources(
        m.version,
        parts.iter().map(|(n, t)| (n.as_str(), t.as_str())),
        symbols.iter().map(|(n, t)| (n.as_str(), t.as_str())),
        templates.iter().map(|(n, t)| (n.as_str(), t.as_str())),
    )
    .unwrap_or_else(|errs| panic!("registry failed to load:\n{errs:#?}"))
}

pub fn load(root: &Path) -> Registry {
    load_sources(root).registry
}
