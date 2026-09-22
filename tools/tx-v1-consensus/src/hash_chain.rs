//! Deterministic native-KAS adaptation of KCC20 hash-chain/v1, using the
//! pinned SilverScript ABI and Rusty-Kaspa's full transaction validator.
use super::*;

const HEAD_VALUE: u64 = 100_000_000;
const PAYMENT: u64 = 20_000_000;
const FEE: u64 = 300_000;
const PAYER_KEY: [u8; 32] = [7; 32];
const OWNER_KEY: [u8; 32] = [9; 32];
const FIRST_LINK_KEY: [u8; 32] = [11; 32];
const SECOND_LINK_KEY: [u8; 32] = [12; 32];
const REPLACEMENT_LINK_KEY: [u8; 32] = [13; 32];

struct Fixture {
    base: Vec<u8>,
    guard_offset: usize,
    borrow_selector: Vec<u8>,
    rotate_selector: Vec<u8>,
    sweep_selector: Vec<u8>,
    source_hash: String,
    compiled_hash: String,
    template_hash: String,
}

#[derive(Clone)]
struct Head {
    outpoint: TransactionOutpoint,
    amount: u64,
    script: ScriptPublicKey,
    redeem: Vec<u8>,
    covenant_id: Hash,
}

#[derive(Clone, Copy)]
enum Authorization {
    Borrow {
        revealed: [u8; 32],
        pubkey: [u8; 32],
        signing_key: [u8; 32],
    },
    Rotate {
        new_guard: [u8; 32],
        signing_key: [u8; 32],
    },
    Sweep {
        signing_key: [u8; 32],
    },
}

pub(super) fn validate_hash_chain(root: &Path) -> Result<serde_json::Value> {
    let fixture = load_fixture(root)?;
    let first_pubkey = key_public(&FIRST_LINK_KEY)?;
    let second_pubkey = key_public(&SECOND_LINK_KEY)?;
    let replacement_pubkey = key_public(&REPLACEMENT_LINK_KEY)?;
    let seed = [0x33; 32];
    let first_guard = next_guard(&seed, &first_pubkey);
    let initial_guard = next_guard(&first_guard, &second_pubkey);
    let replacement_seed = [0x44; 32];
    let replacement_guard = next_guard(&replacement_seed, &replacement_pubkey);

    let (genesis_tx, genesis_entries, genesis_head) = build_genesis(&fixture, initial_guard)?;
    let genesis_fee = validate_full_consensus(&genesis_tx, &genesis_entries)
        .context("hash-chain genesis must pass full consensus")?;
    if genesis_fee != FEE { return Err(anyhow!("hash-chain genesis fee mismatch")); }

    let first_auth = Authorization::Borrow {
        revealed: first_guard,
        pubkey: second_pubkey,
        signing_key: SECOND_LINK_KEY,
    };
    let (first_tx, first_entries, first_head) = build_transition(
        &fixture, &genesis_head, first_guard, PAYMENT, [0x51; 32], first_auth,
    ).context("constructing first delegated borrow")?;
    check_valid_borrow(&first_tx, &first_entries, &genesis_head, &first_head, PAYMENT)?;
    let (duplicate_candidate, duplicate_entries, _) = build_transition(
        &fixture, &genesis_head, first_guard, PAYMENT, [0x59; 32], first_auth,
    )?;
    validate_full_consensus(&duplicate_candidate, &duplicate_entries)
        .context("competing same-link spend must be valid in isolation")?;
    if duplicate_candidate.id() == first_tx.id()
        || duplicate_candidate.inputs[0].previous_outpoint != first_tx.inputs[0].previous_outpoint
        || duplicate_candidate.inputs[0].previous_outpoint == first_head.outpoint {
        return Err(anyhow!("duplicate candidate did not compete for the consumed outpoint"));
    }

    let second_auth = Authorization::Borrow {
        revealed: seed,
        pubkey: first_pubkey,
        signing_key: FIRST_LINK_KEY,
    };
    let (second_tx, second_entries, second_head) = build_transition(
        &fixture, &first_head, seed, PAYMENT, [0x52; 32], second_auth,
    ).context("constructing second delegated borrow")?;
    check_valid_borrow(&second_tx, &second_entries, &first_head, &second_head, PAYMENT)?;
    if first_head.covenant_id != second_head.covenant_id
        || genesis_head.covenant_id != first_head.covenant_id {
        return Err(anyhow!("hash-chain successor changed the KIP-20 identity"));
    }
    if second_tx.inputs[0].previous_outpoint != first_head.outpoint {
        return Err(anyhow!("second borrower did not spend the first accepted successor"));
    }

    let mut wrong_link = first_tx.clone();
    sign_head(&mut wrong_link, &first_entries, &fixture, &genesis_head.redeem,
        Authorization::Borrow { revealed: seed, pubkey: second_pubkey, signing_key: SECOND_LINK_KEY })?;
    expect_consensus_rejection(&wrong_link, &first_entries, "wrong predecessor guard")?;

    let mut wrong_signature = first_tx.clone();
    sign_head(&mut wrong_signature, &first_entries, &fixture, &genesis_head.redeem,
        Authorization::Borrow { revealed: first_guard, pubkey: second_pubkey, signing_key: REPLACEMENT_LINK_KEY })?;
    expect_consensus_rejection(&wrong_signature, &first_entries, "wrong one-time signature")?;

    let mut wrong_sighash_flag = first_tx.clone();
    let signature_script = &mut wrong_sighash_flag.inputs[0].signature_script;
    if signature_script.get(66) != Some(&65) || signature_script.get(131) != Some(&1) {
        return Err(anyhow!("unexpected borrower witness layout for SIGHASH_ALL negative"));
    }
    signature_script[131] = 0;
    wrong_sighash_flag.finalize();
    expect_consensus_rejection(&wrong_sighash_flag, &first_entries, "wrong borrower sighash flag")?;

    let mut wrong_successor = first_tx.clone();
    wrong_successor.outputs[0].script_public_key = genesis_head.script.clone();
    sign_head(&mut wrong_successor, &first_entries, &fixture, &genesis_head.redeem, first_auth)?;
    expect_consensus_rejection(&wrong_successor, &first_entries, "wrong successor P2SH")?;

    let mut duplicate_covenant_output = first_tx.clone();
    duplicate_covenant_output.outputs[1].covenant = Some(CovenantBinding::new(0, genesis_head.covenant_id));
    sign_head(&mut duplicate_covenant_output, &first_entries, &fixture, &genesis_head.redeem, first_auth)?;
    expect_consensus_rejection(&duplicate_covenant_output, &first_entries, "duplicate same-ID output")?;

    let (small_tx, small_entries, small_head) = build_transition(
        &fixture, &genesis_head, first_guard, 1, [0x53; 32], first_auth,
    )?;
    validate_full_consensus(&small_tx, &small_entries)
        .context("small positive top-up must remain consensus-valid")?;
    expect_profile_rejection(
        check_exact_delta(&small_tx, &small_entries, PAYMENT),
        "small top-up exact payment",
    )?;
    if small_head.amount != HEAD_VALUE + 1 {
        return Err(anyhow!("small top-up did not advance the authentic head"));
    }

    let (large_tx, large_entries, _) = build_transition(
        &fixture, &genesis_head, first_guard, PAYMENT + 1, [0x54; 32], first_auth,
    )?;
    validate_full_consensus(&large_tx, &large_entries)
        .context("overpayment must remain consensus-valid")?;
    expect_profile_rejection(check_exact_delta(&large_tx, &large_entries, PAYMENT), "overpayment")?;

    let stale_first = Authorization::Borrow {
        revealed: first_guard,
        pubkey: second_pubkey,
        signing_key: SECOND_LINK_KEY,
    };
    let mut reused_tx = second_tx.clone();
    let reused_entries = second_entries.clone();
    sign_head(&mut reused_tx, &reused_entries, &fixture, &first_head.redeem, stale_first)?;
    expect_consensus_rejection(&reused_tx, &reused_entries, "already consumed first link")?;

    // Both candidates are independently valid against the old outpoint. The
    // UTXO can accept only one; after rotation the old key cannot spend the
    // new P2SH head. This is the abandoned-grant recovery race.
    let rotate_auth = Authorization::Rotate { new_guard: replacement_guard, signing_key: OWNER_KEY };
    let (rotate_tx, rotate_entries, rotated_head) = build_transition(
        &fixture, &first_head, replacement_guard, 0, [0x56; 32], rotate_auth,
    )?;
    validate_full_consensus(&rotate_tx, &rotate_entries)
        .context("owner rotation must pass full consensus")?;
    let mut wrong_owner_signature = rotate_tx.clone();
    sign_head(&mut wrong_owner_signature, &rotate_entries, &fixture, &first_head.redeem,
        Authorization::Rotate { new_guard: replacement_guard, signing_key: FIRST_LINK_KEY })?;
    expect_consensus_rejection(&wrong_owner_signature, &rotate_entries, "wrong owner rotation signature")?;
    let mut unchanged_guard_rotation = rotate_tx.clone();
    unchanged_guard_rotation.outputs[0].script_public_key = first_head.script.clone();
    sign_head(&mut unchanged_guard_rotation, &rotate_entries, &fixture, &first_head.redeem,
        Authorization::Rotate { new_guard: first_guard, signing_key: OWNER_KEY })?;
    expect_consensus_rejection(&unchanged_guard_rotation, &rotate_entries, "owner rotation without a new guard")?;
    if rotated_head.covenant_id != first_head.covenant_id
        || rotated_head.amount != first_head.amount
        || rotate_tx.inputs[0].previous_outpoint != second_tx.inputs[0].previous_outpoint {
        return Err(anyhow!("owner rotation did not preserve the head or compete for its outpoint"));
    }
    let replacement_auth = Authorization::Borrow {
        revealed: replacement_seed,
        pubkey: replacement_pubkey,
        signing_key: REPLACEMENT_LINK_KEY,
    };
    let (recovery_tx, recovery_entries, recovery_head) = build_transition(
        &fixture, &rotated_head, replacement_seed, PAYMENT, [0x58; 32], replacement_auth,
    )?;
    check_valid_borrow(&recovery_tx, &recovery_entries, &rotated_head, &recovery_head, PAYMENT)?;
    let mut stale_after_rotate = recovery_tx.clone();
    let stale_entries = recovery_entries.clone();
    sign_head(&mut stale_after_rotate, &stale_entries, &fixture, &rotated_head.redeem, second_auth)?;
    expect_consensus_rejection(&stale_after_rotate, &stale_entries, "old grant after owner rotation")?;

    let (sweep_tx, sweep_entries) = build_sweep(&fixture, &second_head)?;
    validate_full_consensus(&sweep_tx, &sweep_entries)
        .context("owner sweep must pass full consensus")?;
    let mut unauthorized_sweep = sweep_tx.clone();
    sign_head(&mut unauthorized_sweep, &sweep_entries, &fixture, &second_head.redeem,
        Authorization::Sweep { signing_key: FIRST_LINK_KEY })?;
    expect_consensus_rejection(&unauthorized_sweep, &sweep_entries, "unauthorized owner sweep")?;

    let result = json!({
        "status": "full-consensus-cross-validated",
        "source": {
            "rustyKaspaCommit": EXPECTED_SOURCE_COMMIT,
            "silverscriptCommit": fixture_compiler_commit(),
            "contractSourceSha256": fixture.source_hash,
            "compiledBaseSha256": fixture.compiled_hash,
            "sampleTemplateHash": fixture.template_hash,
        },
        "covenantId": genesis_head.covenant_id.to_string(),
        "chain": {
            "initialGuard": hex::encode(initial_guard),
            "firstRevealedGuard": hex::encode(first_guard),
            "secondRevealedGuard": hex::encode(seed),
            "firstOneTimePublicKey": hex::encode(second_pubkey),
            "secondOneTimePublicKey": hex::encode(first_pubkey),
        },
        "transactions": {
            "genesis": evidence("hash-chain-genesis", &genesis_tx, &genesis_entries, 0)?,
            "borrow1": evidence("hash-chain-borrow-1", &first_tx, &first_entries, PAYMENT)?,
            "borrow2": evidence("hash-chain-borrow-2", &second_tx, &second_entries, PAYMENT)?,
            "smallTopUp": evidence("hash-chain-small-top-up", &small_tx, &small_entries, 1)?,
            "ownerRotation": evidence("hash-chain-owner-rotation", &rotate_tx, &rotate_entries, 0)?,
            "postRotationBorrow": evidence("hash-chain-post-rotation-borrow", &recovery_tx, &recovery_entries, PAYMENT)?,
            "ownerSweep": evidence("hash-chain-owner-sweep", &sweep_tx, &sweep_entries, 0)?,
        },
        "negative": {
            "wrongLink": "consensus-rejected",
            "wrongOneTimeSignature": "consensus-rejected",
            "wrongBorrowerSighashFlag": "consensus-rejected",
            "wrongOwnerRotationSignature": "consensus-rejected",
            "unchangedOwnerRotationGuard": "consensus-rejected",
            "wrongSuccessor": "consensus-rejected",
            "duplicateCovenantOutput": "consensus-rejected",
            "reusedLinkOnSuccessor": "consensus-rejected",
            "duplicateBorrowRace": "competing-valid-spends-of-one-outpoint; second is stale after first",
            "oldGrantAfterOwnerRotation": "consensus-rejected",
            "unauthorizedOwnerSweep": "consensus-rejected",
            "smallPositiveTopUp": "consensus-accepted-exact-rejected",
            "overpayment": "consensus-accepted-exact-rejected",
            "ownerRotationRace": "competing-valid-spends-of-one-outpoint",
        },
    });
    if env::var("KASPA_X402_GENERATE_HASH_CHAIN_VECTORS").as_deref() != Ok("1") {
        let vector_path = root.join("vectors/hash-chain/consensus-v1.json");
        let expected: serde_json::Value = serde_json::from_str(&fs::read_to_string(&vector_path)
            .with_context(|| format!("reading {}", vector_path.display()))?)?;
        if expected["expected"] != result {
            return Err(anyhow!("hash-chain consensus vector is stale; regenerate it"));
        }
    }
    Ok(result)
}

fn fixture_compiler_commit() -> &'static str {
    "3ed973335b59269293564805cc2c58a14595ec03"
}

fn load_fixture(root: &Path) -> Result<Fixture> {
    let file = root.join("contracts/fixtures/kaspa-x402-hash-chain-head-v1.json");
    let value: serde_json::Value = serde_json::from_str(&fs::read_to_string(&file)?)?;
    if value["compiler"]["checkedCommit"].as_str() != Some(fixture_compiler_commit()) {
        return Err(anyhow!("hash-chain SilverScript compiler commit is not pinned"));
    }
    let source_hash = json_string(&value, "sourceSha256")?.to_owned();
    let source = root.join(json_string(&value, "source")?);
    if hex::encode(Sha256::digest(fs::read(source)?)) != source_hash {
        return Err(anyhow!("hash-chain SilverScript source hash differs from artifact"));
    }
    let contract = &value["artifact"]["contracts"]["KaspaX402HashChainHeadV1"];
    let base: Vec<u8> = serde_json::from_value(contract["compiled"]["bytecode"].clone())?;
    let compiled_hash = json_string(&value, "compiledBaseSha256")?.to_owned();
    if hex::encode(Sha256::digest(&base)) != compiled_hash {
        return Err(anyhow!("hash-chain compiled ABI bytecode hash differs from artifact"));
    }
    let sample_guard = parse_hex(json_string(&value["constructor"], "sampleGuard")?, "sample guard")?;
    let guard_offset = usize::try_from(value["layout"]["guardOffset"].as_u64()
        .context("guardOffset must be a uint64 JSON number")?)?;
    if base.get(guard_offset..guard_offset + 32) != Some(sample_guard.as_slice()) {
        return Err(anyhow!("hash-chain guard offset does not match pinned bytecode"));
    }
    let owner_bytes = parse_hex(json_string(&value["constructor"], "sampleOwnerPublicKey")?, "owner")?;
    let owner: [u8; 32] = owner_bytes.try_into().map_err(|_| anyhow!("owner key is not 32 bytes"))?;
    if owner != key_public(&OWNER_KEY)? { return Err(anyhow!("fixture owner does not match proof key")); }
    Ok(Fixture {
        base,
        guard_offset,
        borrow_selector: parse_hex(json_string(&value["selectors"], "borrow")?, "borrow selector")?,
        rotate_selector: parse_hex(json_string(&value["selectors"], "ownerRotate")?, "rotate selector")?,
        sweep_selector: parse_hex(json_string(&value["selectors"], "ownerSweep")?, "sweep selector")?,
        source_hash,
        compiled_hash,
        template_hash: json_string(&value, "sampleTemplateHash")?.to_owned(),
    })
}

fn key_public(secret: &[u8; 32]) -> Result<[u8; 32]> {
    Ok(Keypair::from_seckey_slice(SECP256K1, secret)?.x_only_public_key().0.serialize())
}

fn next_guard(previous: &[u8; 32], pubkey: &[u8; 32]) -> [u8; 32] {
    let mut input = [0_u8; 64];
    input[..32].copy_from_slice(previous);
    input[32..].copy_from_slice(pubkey);
    *blake3::hash(&input).as_bytes()
}

fn redeem_for(fixture: &Fixture, guard: &[u8; 32]) -> Vec<u8> {
    let mut script = fixture.base.clone();
    script[fixture.guard_offset..fixture.guard_offset + 32].copy_from_slice(guard);
    script
}

fn build_genesis(fixture: &Fixture, initial_guard: [u8; 32]) -> Result<(Transaction, Vec<UtxoEntry>, Head)> {
    let redeem = redeem_for(fixture, &initial_guard);
    let head_spk = pay_to_script_hash_script(&redeem);
    let funding_spk = p2pk_script(&PAYER_KEY)?;
    let funding_outpoint = TransactionOutpoint::new(TransactionId::from_bytes([0x50; 32]), 0);
    let covenant_id = kaspa_consensus_core::hashing::covenant_id::covenant_id(
        funding_outpoint,
        std::iter::once((0, &TransactionOutput::new(HEAD_VALUE, head_spk.clone()))),
    );
    let input = TransactionInput::new_with_compute_budget(funding_outpoint, vec![], 0, 10);
    let output = TransactionOutput::with_covenant(
        HEAD_VALUE, head_spk.clone(), Some(CovenantBinding::new(0, covenant_id)),
    );
    let mut tx = Transaction::new(1, vec![input], vec![output], 0, SubnetworkId::default(), 0, vec![]);
    let entries = vec![UtxoEntry::new(HEAD_VALUE + FEE, funding_spk, 0, false, None)];
    set_storage_mass(&tx, &entries)?;
    tx.finalize();
    let populated = PopulatedTransaction::new(&tx, entries.clone());
    tx.inputs[0].signature_script = deterministic_signature(&populated, 0, &PAYER_KEY)?;
    tx.finalize();
    let head = Head {
        outpoint: TransactionOutpoint::new(tx.id(), 0),
        amount: HEAD_VALUE,
        script: head_spk,
        redeem,
        covenant_id,
    };
    Ok((tx, entries, head))
}

fn build_transition(
    fixture: &Fixture,
    head: &Head,
    new_guard: [u8; 32],
    added_value: u64,
    payer_outpoint: [u8; 32],
    authorization: Authorization,
) -> Result<(Transaction, Vec<UtxoEntry>, Head)> {
    let payer_spk = p2pk_script(&PAYER_KEY)?;
    let payer_amount: u64 = 50_000_000;
    let change = payer_amount.checked_sub(added_value + FEE).context("payer funding is too small")?;
    let successor_amount = head.amount + added_value;
    let successor_redeem = redeem_for(fixture, &new_guard);
    let successor_spk = pay_to_script_hash_script(&successor_redeem);
    let inputs = vec![
        TransactionInput::new_with_compute_budget(head.outpoint, vec![], 0, 100),
        TransactionInput::new_with_compute_budget(
            TransactionOutpoint::new(TransactionId::from_bytes(payer_outpoint), 0),
            vec![], 0, 10,
        ),
    ];
    let outputs = vec![
        TransactionOutput::with_covenant(
            successor_amount, successor_spk.clone(), Some(CovenantBinding::new(0, head.covenant_id)),
        ),
        TransactionOutput::new(change, payer_spk.clone()),
    ];
    let mut tx = Transaction::new(1, inputs, outputs, 0, SubnetworkId::default(), 0, vec![]);
    let entries = vec![
        UtxoEntry::new(head.amount, head.script.clone(), 0, false, Some(head.covenant_id)),
        UtxoEntry::new(payer_amount, payer_spk, 0, false, None),
    ];
    sign_head(&mut tx, &entries, fixture, &head.redeem, authorization)?;
    let units = match measure_input_units(&tx, &entries, 0) {
        Ok(units) => units,
        Err(error) => return Err(anyhow!("measuring signed hash-chain head witness: {error}; trace: {}", trace_input(&tx, &entries, 0)?)),
    };
    let budget = ComputeBudget::checked_covering_script_units(units.into())
        .ok_or_else(|| anyhow!("hash-chain head compute budget exceeds uint16"))?;
    tx.inputs[0].compute_commit = budget.into();
    sign_head(&mut tx, &entries, fixture, &head.redeem, authorization)?;
    let successor = Head {
        outpoint: TransactionOutpoint::new(tx.id(), 0),
        amount: successor_amount,
        script: successor_spk,
        redeem: successor_redeem,
        covenant_id: head.covenant_id,
    };
    Ok((tx, entries, successor))
}

fn build_sweep(fixture: &Fixture, head: &Head) -> Result<(Transaction, Vec<UtxoEntry>)> {
    let owner_spk = p2pk_script(&OWNER_KEY)?;
    let mut tx = Transaction::new(
        1,
        vec![TransactionInput::new_with_compute_budget(head.outpoint, vec![], 0, 100)],
        vec![TransactionOutput::new(head.amount - FEE, owner_spk)],
        0, SubnetworkId::default(), 0, vec![],
    );
    let entries = vec![UtxoEntry::new(head.amount, head.script.clone(), 0, false, Some(head.covenant_id))];
    let authorization = Authorization::Sweep { signing_key: OWNER_KEY };
    sign_head(&mut tx, &entries, fixture, &head.redeem, authorization)?;
    let units = measure_input_units(&tx, &entries, 0)?;
    tx.inputs[0].compute_commit = ComputeBudget::checked_covering_script_units(units.into())
        .ok_or_else(|| anyhow!("hash-chain sweep compute budget exceeds uint16"))?
        .into();
    sign_head(&mut tx, &entries, fixture, &head.redeem, authorization)?;
    Ok((tx, entries))
}

fn sign_head(tx: &mut Transaction, entries: &[UtxoEntry], fixture: &Fixture, redeem: &[u8], authorization: Authorization) -> Result<()> {
    for input in &mut tx.inputs { input.signature_script.clear(); }
    set_storage_mass(tx, entries)?;
    tx.finalize();
    let signer = match authorization {
        Authorization::Borrow { signing_key, .. } => signing_key,
        Authorization::Rotate { signing_key, .. } => signing_key,
        Authorization::Sweep { signing_key } => signing_key,
    };
    let populated = PopulatedTransaction::new(tx, entries.to_vec());
    let signature_push = deterministic_signature(&populated, 0, &signer)?;
    let signature = &signature_push[1..];
    let mut builder = ScriptBuilder::new();
    match authorization {
        Authorization::Borrow { revealed, pubkey, .. } => {
            builder.add_data(&revealed)?.add_data(&pubkey)?.add_data(signature)?
                .add_data(&fixture.borrow_selector)?;
        }
        Authorization::Rotate { new_guard, .. } => {
            builder.add_data(&new_guard)?.add_data(signature)?.add_data(&fixture.rotate_selector)?;
        }
        Authorization::Sweep { .. } => {
            builder.add_data(signature)?.add_data(&fixture.sweep_selector)?;
        }
    }
    tx.inputs[0].signature_script = builder.add_data(redeem)?.drain();
    if tx.inputs.len() > 1 {
        let populated = PopulatedTransaction::new(tx, entries.to_vec());
        tx.inputs[1].signature_script = deterministic_signature(&populated, 1, &PAYER_KEY)?;
    }
    tx.finalize();
    Ok(())
}

fn check_exact_delta(tx: &Transaction, entries: &[UtxoEntry], amount: u64) -> Result<()> {
    let expected = entries[0].amount.checked_add(amount).context("head value overflow")?;
    if tx.outputs[0].value != expected {
        return Err(anyhow!("successor KAS gain is not the quoted exact amount"));
    }
    Ok(())
}

fn check_valid_borrow(tx: &Transaction, entries: &[UtxoEntry], old: &Head, next: &Head, amount: u64) -> Result<()> {
    let fee = validate_full_consensus(tx, entries).context("delegated borrow must pass full consensus")?;
    if fee != FEE || transaction_fee(tx, entries)? != FEE { return Err(anyhow!("borrow final fee mismatch")); }
    check_exact_delta(tx, entries, amount)?;
    if tx.outputs[0].script_public_key != next.script
        || tx.outputs[0].covenant.as_ref().map(|binding| binding.covenant_id) != Some(old.covenant_id)
        || tx.inputs[0].previous_outpoint != old.outpoint {
        return Err(anyhow!("borrow successor lineage mismatch"));
    }
    let units = measure_input_units(tx, entries, 0)?;
    let expected_budget = ComputeBudget::checked_covering_script_units(units.into())
        .context("hash-chain head units exceed uint16 budget")?;
    if tx.inputs[0].compute_commit.compute_budget() != Some(expected_budget.value()) {
        return Err(anyhow!("borrow head compute budget is not minimal"));
    }
    Ok(())
}

fn evidence(kind: &str, tx: &Transaction, entries: &[UtxoEntry], amount: u64) -> Result<serde_json::Value> {
    let units = (0..tx.inputs.len()).map(|index| measure_input_units(tx, entries, index)).collect::<Result<Vec<_>>>()?;
    let mut value = exact_evidence(kind, tx, entries, &units);
    value["amount"] = json!(amount.to_string());
    value["headCovenantId"] = entries.first().and_then(|entry| entry.covenant_id).map(|id| json!(id.to_string())).unwrap_or(serde_json::Value::Null);
    Ok(value)
}

fn trace_input(tx: &Transaction, entries: &[UtxoEntry], input_index: usize) -> Result<String> {
    let populated = PopulatedTransaction::new(tx, entries.to_vec());
    let cache = Cache::new(64);
    let reused = SigHashReusedValuesUnsync::new();
    let covenants = CovenantsContext::from_tx(&populated).map_err(|error| anyhow!(error.to_string()))?;
    let ctx = EngineCtx::new(&cache).with_reused(&reused).with_covenants_ctx(&covenants);
    let flags = EngineFlags { sigop_script_units: Gram(TESTNET_PARAMS.mass_per_sig_op).into() };
    let mut trace = Vec::new();
    let mut engine = TxScriptEngine::from_transaction_input(
        &populated, &populated.tx.inputs[input_index], input_index, &entries[input_index], ctx, flags,
    ).with_opcode_execution_log_buffer(&mut trace);
    let outcome = engine.execute().err().map(|error| error.to_string());
    drop(engine);
    let lines = String::from_utf8_lossy(&trace);
    Ok(format!("{}\n{}", outcome.unwrap_or_else(|| "valid".into()),
        lines.lines().rev().take(20).collect::<Vec<_>>().into_iter().rev()
            .map(|line| {
                let op = line.split(", astack:").next().unwrap_or(line);
                let top = line.split("dstack: [").nth(1).unwrap_or("")
                    .trim_end_matches(']').rsplit(", ").take(4).collect::<Vec<_>>()
                    .into_iter().rev().collect::<Vec<_>>().join(", ");
                format!("{op}: {top}")
            }).collect::<Vec<_>>().join("\n")))
}
