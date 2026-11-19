// Contrato de alto nivel compartido entre web y CLI (Protocol 5).

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 5;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileEntry {
    pub name: String,
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// Los archivos que ha pedido el receptor, como indices del manifiesto.
/// `None` es "todos". Indices invalidos se descartan, se eliminan duplicados y se ordenan.
pub fn picked_files(files: Option<&[i64]>, count: usize) -> Option<Vec<usize>> {
    let list = files?;
    let mut set = BTreeSet::new();
    for &idx in list {
        if idx >= 0 && (idx as usize) < count {
            set.insert(idx as usize);
        }
    }
    Some(set.into_iter().collect())
}
