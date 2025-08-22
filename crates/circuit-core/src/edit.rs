//! Editor gestures as ops (LLD §10). These only read the circuit: the ops they return still go
//! through `apply()`, as one undo step. They live here, not in the editor, because they follow the
//! IR's own rules (refdes format, net ids, net kinds), and the tutor's "try" ops need them too.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::apply::{check_pin_exists, net_conflict, valid_net_id};
use crate::error::{ErrorCode as E, OpError, err};
use crate::ir::*;
use crate::ops::{NetConnect, NetDisconnect, Op};
use crate::registry::Registry;

/// Where a wire ends: a pin, an existing net (a wire or a power/ground flag of it), or a supply
/// rail, which is created with its kind if it does not exist yet (the editor's GND and rail tools).
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum WireEnd {
    Pin(PinRef),
    Net(NetId),
    Rail { net: NetId, kind: NetKind },
}

/// The refdes for a new instance of `part`: its category letter and the lowest free number, so
/// deleting R2 and placing a resistor gives R2 again.
pub fn next_refdes(c: &Circuit, reg: &Registry, part: &str) -> Result<RefDes, OpError> {
    let def =
        reg.part(part).ok_or_else(|| OpError::new(E::PartNotInRegistry, format!("{part} is not in the registry")))?;
    let letter = def.category.letter();
    (1..=9999)
        .map(|n| format!("{letter}{n}"))
        .find(|r| !c.parts.contains_key(r))
        .ok_or_else(|| OpError::new(E::LimitExceeded, format!("no free {letter} refdes")))
}

/// A net id no existing net clashes with: `N1`, `N2`, ...
fn fresh_net_id(c: &Circuit) -> NetId {
    (1..)
        .map(|n| format!("N{n}"))
        .find(|id| valid_net_id(id) && net_conflict(c, id, None).is_none())
        .expect("fewer nets than ids")
}

/// Which of two nets survives a merge: ground, then power, then a block's port net, then a
/// labelled net, then the larger net, then the smaller id. The other is folded into it.
fn survivor<'a>(c: &Circuit, a: &'a Net, b: &'a Net) -> (&'a Net, &'a Net) {
    let is_port = |n: &Net| c.blocks.values().any(|blk| blk.ports.iter().any(|p| p.net == n.id));
    let rank = |n: &Net| {
        (
            matches!(n.kind, NetKind::Ground),
            matches!(n.kind, NetKind::Power { .. }),
            is_port(n),
            n.label.is_some(),
            n.pins.len(),
            std::cmp::Reverse(n.id.clone()),
        )
    };
    if rank(a) >= rank(b) { (a, b) } else { (b, a) }
}

/// Ops for drawing a wire from pin `from` to `to`:
/// - two free pins: a new net;
/// - a free pin and a net (or a pin on one): the pin joins that net;
/// - two different nets: they merge, the lower-ranked net's pins moving to the other
///   (`net.disconnect` + `net.connect`; undo restores the old net with its kind and label).
///
/// Wiring a pin to its own net is refused with `pin_already_connected`.
///
/// A rail that exists behaves like that net, but must have the requested kind. A new rail takes
/// the pin; if the pin is on a signal net, that whole net becomes the rail. A pin on another
/// supply or on ground is refused rather than shorted to a rail that does not exist yet.
pub fn connect(c: &Circuit, reg: &Registry, from: &PinRef, to: &WireEnd) -> Result<Vec<Op>, OpError> {
    check_pin_exists(c, reg, from)?;
    let idx = c.pin_index();
    let from_net = idx.get(from).map(|n| &c.nets[n.as_str()]);
    if let WireEnd::Rail { net, kind } = to {
        if let Some(existing) = c.nets.get(net) {
            if existing.kind != *kind {
                return err(E::NetInvalid, format!("{net} is already {}", kind_text(&existing.kind)));
            }
            return connect(c, reg, from, &WireEnd::Net(net.clone()));
        }
        let create =
            |pins: Vec<PinRef>| Op::NetConnect(NetConnect { net: net.clone(), pins, kind: Some(*kind), label: None });
        return match from_net {
            None => Ok(vec![create(vec![from.clone()])]),
            Some(x) if x.kind == NetKind::Signal => {
                let pins: Vec<PinRef> = x.pins.iter().cloned().collect();
                Ok(vec![Op::NetDisconnect(NetDisconnect { net: x.id.clone(), pins: pins.clone() }), create(pins)])
            }
            Some(x) => err(
                E::PinAlreadyConnected,
                format!("{from} is on {} ({}); disconnect it first", x.id, kind_text(&x.kind)),
            ),
        };
    }
    let to_net = match to {
        WireEnd::Pin(p) => {
            check_pin_exists(c, reg, p)?;
            if p == from {
                return err(E::PinAlreadyConnected, format!("cannot wire {p} to itself"));
            }
            idx.get(p).map(|n| &c.nets[n.as_str()])
        }
        WireEnd::Net(id) => Some(c.nets.get(id).ok_or_else(|| OpError::new(E::NetNotFound, format!("no net {id}")))?),
        WireEnd::Rail { .. } => unreachable!("handled above"),
    };
    let join = |net: &Net, pin: &PinRef| {
        Op::NetConnect(NetConnect { net: net.id.clone(), pins: vec![pin.clone()], kind: None, label: None })
    };
    Ok(match (from_net, to_net) {
        (None, None) => {
            let WireEnd::Pin(p) = to else { unreachable!("a net end always has a net") };
            vec![Op::NetConnect(NetConnect {
                net: fresh_net_id(c),
                pins: vec![from.clone(), p.clone()],
                kind: None,
                label: None,
            })]
        }
        (None, Some(net)) => vec![join(net, from)],
        (Some(net), None) => {
            let WireEnd::Pin(p) = to else { unreachable!("a net end always has a net") };
            vec![join(net, p)]
        }
        (Some(a), Some(b)) if a.id == b.id => {
            let what = match to {
                WireEnd::Pin(p) => p.to_string(),
                WireEnd::Net(id) | WireEnd::Rail { net: id, .. } => id.clone(),
            };
            return err(E::PinAlreadyConnected, format!("{from} and {what} are already connected (net {})", a.id));
        }
        (Some(a), Some(b)) => {
            let (keep, fold) = survivor(c, a, b);
            let pins: Vec<PinRef> = fold.pins.iter().cloned().collect();
            vec![
                Op::NetDisconnect(NetDisconnect { net: fold.id.clone(), pins: pins.clone() }),
                Op::NetConnect(NetConnect { net: keep.id.clone(), pins, kind: None, label: None }),
            ]
        }
    })
}

fn kind_text(kind: &NetKind) -> String {
    match kind {
        NetKind::Signal => "a signal net".to_string(),
        NetKind::Power { volts } => format!("a {volts} V rail"),
        NetKind::Ground => "ground".to_string(),
    }
}
