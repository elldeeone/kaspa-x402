//! Execute the pinned node's unmodified default standardness/relay checks.
//! This is not full mempool admission: no live UTXO lookup, conflicts or load.
use super::*;
use crate::mempool::{Mempool, config::Config, errors::NonStandardError};
use kaspa_consensus_core::tx::MutableTransaction;

pub(super) fn validate(tx: &Transaction, entries: &[UtxoEntry]) -> Result<serde_json::Value> {
    let params = TESTNET_PARAMS;
    let pool = Mempool {
        config: Config::build_default(
            params.target_time_per_block(),
            false,
            params.block_mass_limits,
            params.block_lane_limits,
        ),
    };
    let mut candidate =
        MutableTransaction::with_entries(std::sync::Arc::new(tx.clone()), entries.to_vec());
    let masses = MassCalculator::new_with_consensus_params(&params).calc_non_contextual_masses(tx);
    candidate.calculated_non_contextual_masses = Some(masses);
    candidate.calculated_fee = Some(transaction_fee(tx, entries)?);
    pool.check_transaction_standard_in_isolation(&candidate)?;
    pool.check_transaction_standard_in_context(&candidate)
        .context("consensus-valid fixture fails default node relay policy")?;

    // Policy-only controls: vary the calculated fee passed by consensus, keeping
    // the exact serialized transaction and its independently calculated masses.
    // These are not claimed to be newly signed, consensus-valid transactions.
    candidate.calculated_fee = Some(0);
    let minimum = match pool.check_transaction_standard_in_context(&candidate) {
        Err(NonStandardError::RejectInsufficientComputeFee(_, _, minimum, _))
        | Err(NonStandardError::RejectInsufficientTransientFee(_, _, minimum, _)) => minimum,
        other => {
            return Err(anyhow!(
                "zero-fee policy control did not fail for fee: {other:?}"
            ));
        }
    };
    candidate.calculated_fee = Some(minimum - 1);
    let below = pool
        .check_transaction_standard_in_context(&candidate)
        .unwrap_err();
    match &below {
        NonStandardError::RejectInsufficientComputeFee(_, fee, required, _)
        | NonStandardError::RejectInsufficientTransientFee(_, fee, required, _)
            if *fee == minimum - 1 && *required == minimum =>
        {
            ()
        }
        other => {
            return Err(anyhow!(
                "floor-minus-one control failed for wrong reason: {other:?}"
            ));
        }
    }
    candidate.calculated_fee = Some(minimum);
    pool.check_transaction_standard_in_context(&candidate)
        .context("exact relay floor policy control must pass")?;
    Ok(json!({
        "status": "accepted",
        "scope": "default-standardness-and-relay-policy-not-full-mempool-admission",
        "source": "mining/src/mempool/check_transaction_standard.rs",
        "feeSompi": transaction_fee(tx, entries)?.to_string(),
        "minimumFeeSompi": minimum.to_string(),
        "minimumRelayFeeSompiPerKg": pool.config.minimum_relay_transaction_fee.to_string(),
        "computeMass": masses.compute_mass.to_string(),
        "normalizedTransientMass": masses.normalized_transient(&pool.config.mempool_mass_cofactors).to_string(),
        "feeFieldControls": { "floorMinusOne": below.to_string(), "exactFloor": "accepted" },
    }))
}
