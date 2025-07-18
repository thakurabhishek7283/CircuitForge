//! Compile `registry/` (YAML) into the bundle the browser and API load (LLD §12 step 3).
//! `cargo run -p circuit-core --example bundle_registry [-- <out_dir>]`
//! Writes `<out_dir>/registry-<version>.json` and the model files its parts include under
//! `<out_dir>/registry-<version>/` (default out_dir: `target/registry`). Prints the JSON path.

#[path = "support/registry_dir.rs"]
mod registry_dir;

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

fn main() {
    let root = registry_dir::repo_root();
    let src = root.join("registry");
    let reg = registry_dir::load(&src);
    let out_dir = std::env::args().nth(1).map(PathBuf::from).unwrap_or_else(|| root.join("target/registry"));
    fs::create_dir_all(&out_dir).expect("create output dir");

    let models: BTreeSet<&str> = reg.parts.values().filter_map(|p| p.spice.as_ref()?.include.as_deref()).collect();
    let model_dir = out_dir.join(format!("registry-{}", reg.version));
    for m in models {
        let to = model_dir.join(m);
        fs::create_dir_all(to.parent().unwrap()).expect("create model dir");
        fs::copy(src.join(m), &to).unwrap_or_else(|e| panic!("copy {m}: {e}"));
    }

    let path = out_dir.join(format!("registry-{}.json", reg.version));
    fs::write(&path, serde_json::to_string(&reg).expect("serialize")).expect("write bundle");
    println!("{}", path.display());
}
