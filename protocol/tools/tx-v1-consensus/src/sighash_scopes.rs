//! Independent consensus oracle for signature scopes and covenant guards.
use super::*;

pub(super) fn validate(vectors: &[(&str, VectorFile)]) -> Result<serde_json::Value> {
    let mut transactions = Vec::new();
    for flag in [1, 2, 4, 129, 130, 132] {
        let scope = SigHashType::from_u8(flag).map_err(|e| anyhow!(e))?;
        for (_, vector) in vectors {
            let mut tx = build_transaction(&vector.expected.transaction)?;
            let entries = build_utxo_entries(&vector.expected.transaction)?;
            let kind = vector.expected.kind.strip_prefix("batch-").unwrap_or(vector.expected.kind.as_str());
            resign(&mut tx, &entries, kind, scope)?;
            validate_full_consensus(&tx, &entries)
                .with_context(|| format!("{kind} sighash {flag}"))?;
            let populated = PopulatedTransaction::new(&tx, entries.clone());
            let digests: Vec<_> = (0..tx.inputs.len()).map(|index| {
                calc_schnorr_signature_hash(&populated, index, scope, &SigHashReusedValuesUnsync::new()).to_string()
            }).collect();
            transactions.push(json!({"kind": kind, "hashType": flag,
                "transaction": exact_evidence(kind, &tx, &entries, &[])["transaction"].clone(), "digests": digests}));
            // Even NONE must not bypass the independently enforced payout/refund destination.
            if kind == "claim" || kind == "refund" {
                tx.outputs[0].script_public_key = p2pk_script(&[6; 32])?;
                resign(&mut tx, &entries, kind, scope)?;
                expect_consensus_rejection(&tx, &entries, "redirect with valid scoped signatures")?;
            }
        }
        let (mut tx, entries, _) = build_standard_native_exact()?;
        for index in 0..tx.inputs.len() {
            let populated = PopulatedTransaction::new(&tx, entries.clone());
            tx.inputs[index].signature_script = deterministic_signature_with_type(&populated, index, &[7; 32], scope)?;
        }
        tx.finalize();
        validate_full_consensus(&tx, &entries).context("standard-native sighash mode")?;
        let populated = PopulatedTransaction::new(&tx, entries.clone());
        let digests: Vec<_> = (0..tx.inputs.len()).map(|index| {
            calc_schnorr_signature_hash(&populated, index, scope, &SigHashReusedValuesUnsync::new()).to_string()
        }).collect();
        transactions.push(json!({"kind": "standard-native", "hashType": flag,
            "transaction": exact_evidence("standard-native", &tx, &entries, &[])["transaction"].clone(), "digests": digests}));
    }
    let top_up = &vectors.iter().find(|(_, vector)| vector.expected.kind == "batch-top-up")
        .context("missing top-up vector")?.1.expected.transaction;
    let entries = build_utxo_entries(top_up)?;
    let mut mixed_top_ups = Vec::new();
    for client_flag in [1, 2, 4, 129, 130, 132] {
        for provider_flag in [1, 2, 4, 129, 130, 132] {
            let mut tx = build_transaction(top_up)?;
            resign(&mut tx, &entries, "top-up", SIG_HASH_ALL)?;
            let populated = PopulatedTransaction::new(&tx, entries.clone());
            let client = deterministic_signature_with_type(&populated, 0, &[7; 32], SigHashType::from_u8(client_flag).unwrap())?;
            let provider = deterministic_signature_with_type(&populated, 0, &[9; 32], SigHashType::from_u8(provider_flag).unwrap())?;
            tx.inputs[0].signature_script[1..66].copy_from_slice(&client[1..66]);
            tx.inputs[0].signature_script[67..132].copy_from_slice(&provider[1..66]);
            tx.finalize();
            validate_full_consensus(&tx, &entries).context("mixed top-up signatures")?;
            mixed_top_ups.push(json!({"client": client_flag, "provider": provider_flag, "status": "consensus-accepted"}));
        }
    }
    for flag in [4, 132] {
        let scope = SigHashType::from_u8(flag).unwrap();
        let mut tx = build_transaction(top_up)?;
        let mut entries = entries.clone();
        let mut extra = tx.inputs[1].clone();
        extra.previous_outpoint.transaction_id = TransactionId::from_bytes([0xee; 32]);
        tx.inputs.push(extra);
        entries.push(entries[1].clone());
        resign(&mut tx, &entries, "top-up", scope)?;
        validate_full_consensus(&tx, &entries).context("SINGLE with no corresponding output")?;
        let populated = PopulatedTransaction::new(&tx, entries.clone());
        let digests: Vec<_> = (0..tx.inputs.len()).map(|index| {
            calc_schnorr_signature_hash(&populated, index, scope, &SigHashReusedValuesUnsync::new()).to_string()
        }).collect();
        transactions.push(json!({"kind": "single-without-output", "hashType": flag,
            "transaction": exact_evidence("single-without-output", &tx, &entries, &[])["transaction"].clone(), "digests": digests}));
    }
    Ok(json!({"status": "full-consensus-cross-validated", "transactions": transactions, "mixedTopUps": mixed_top_ups}))
}

fn resign(tx: &mut Transaction, entries: &[UtxoEntry], kind: &str, scope: SigHashType) -> Result<()> {
    set_storage_mass(tx, entries)?;
    tx.finalize();
    for (index, entry) in entries.iter().enumerate() {
        let populated = PopulatedTransaction::new(tx, entries.to_vec());
        let key = if entry.covenant_id.is_some() && kind == "claim" { [9; 32] } else { [7; 32] };
        let signature = deterministic_signature_with_type(&populated, index, &key, scope)?;
        let provider_signature = if entry.covenant_id.is_some() && kind == "top-up" {
            Some(deterministic_signature_with_type(&populated, index, &[9; 32], scope)?)
        } else { None };
        if entry.covenant_id.is_none() {
            tx.inputs[index].signature_script = signature;
        } else {
            tx.inputs[index].signature_script[1..66].copy_from_slice(&signature[1..66]);
            if let Some(signature) = provider_signature {
                tx.inputs[index].signature_script[67..132].copy_from_slice(&signature[1..66]);
            }
        }
    }
    tx.finalize();
    Ok(())
}
