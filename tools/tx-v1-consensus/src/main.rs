use anyhow::{Context, Result, anyhow};
use kaspa_addresses::{Address, Prefix};
use kaspa_consensus::processes::transaction_validator::{
    TransactionValidator, tx_validation_in_utxo_context::TxValidationFlags,
};
use kaspa_consensus_core::{
    config::params::TESTNET_PARAMS,
    hashing::{
        HasherExtensions,
        sighash::{
            SigHashReusedValuesUnsync, calc_schnorr_signature_hash, outputs_hash, payload_hash,
            previous_outputs_hash, sequences_hash, sig_op_counts_hash,
        },
        sighash_type::SIG_HASH_ALL,
        tx as tx_hashing,
    },
    mass::{ComputeBudget, Gram, MassCalculator, transaction_estimated_serialized_size},
    subnets::SubnetworkId,
    tx::{
        CovenantBinding, PopulatedTransaction, ScriptPublicKey, Transaction, TransactionId,
        TransactionInput, TransactionOutpoint, TransactionOutput, UtxoEntry, VerifiableTransaction,
    },
};
use kaspa_hashes::{
    Hash, Hasher, HasherBase, TransactionHash,
    sha2::{Digest, Sha256},
};
use kaspa_txscript::{
    EngineCtx, EngineFlags, TxScriptEngine,
    caches::Cache,
    opcodes::codes::{
        OpCheckSig, OpElse, OpEndIf, OpEqualVerify, OpFalse, OpGreaterThanOrEqual, OpIf, OpSub,
        OpTxInputAmount, OpTxInputIndex, OpTxInputSpk, OpTxOutputAmount, OpTxOutputSpk,
    },
    pay_to_address_script, pay_to_script_hash_script,
    script_builder::ScriptBuilder,
};
use secp256k1::{Keypair, Message, SECP256K1, XOnlyPublicKey, schnorr::Signature};
use serde::Deserialize;
use serde_json::json;
use std::{env, fs, path::Path, str::FromStr};

const EXPECTED_SOURCE_COMMIT: &str = "78257f273a26c4be085bab0f79437dee99ca8835";
const STORAGE_MASS_PARAMETER: u64 = 1_000_000_000_000;
const POST_TOCCATA_DAA_SCORE: u64 = 600_000_000;
const EXACT_FEE_SOMPI: u64 = 200_000;
const EXACT_PAYMENT_SOMPI: u64 = 20_000_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VectorFile {
    kind: String,
    expected: Artifact,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Artifact {
    kind: String,
    transaction: ArtifactTransaction,
    serialized_transaction: String,
    transaction_id: String,
    transaction_hash: String,
    txid: TxIdDebug,
    hash: HashDebug,
    sighash: SighashDebug,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactTransaction {
    version: u16,
    inputs: Vec<ArtifactInput>,
    outputs: Vec<ArtifactOutput>,
    lock_time: String,
    subnetwork_id: String,
    gas: String,
    payload: String,
    mass: String,
    estimated_serialized_size: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactInput {
    previous_outpoint: ArtifactOutpoint,
    signature_script: String,
    sequence: String,
    compute_budget: u16,
    utxo: ArtifactUtxo,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactOutpoint {
    txid: String,
    index: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactUtxo {
    amount: String,
    script_public_key: String,
    block_daa_score: String,
    is_coinbase: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactOutput {
    amount: String,
    script_public_key: String,
    covenant: Option<ArtifactCovenant>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactCovenant {
    authorizing_input: u16,
    covenant_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TxIdDebug {
    payload_digest: String,
    rest_preimage: String,
    rest_digest: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HashDebug {
    preimage: String,
    digest: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SighashDebug {
    input_index: usize,
    preimage: String,
    digest: String,
}

fn main() -> Result<()> {
    let repo_root = env::args()
        .nth(1)
        .context("usage: tx-v1-consensus <repo-root>")?;
    let repo_root = Path::new(&repo_root);
    let vector_paths = [
        "vectors/tx-v1/batch-claim.json",
        "vectors/tx-v1/batch-refund.json",
    ];
    let mut checked = Vec::new();

    for relative_path in vector_paths {
        let vector = read_vector(&repo_root.join(relative_path))?;
        validate_vector(&vector).with_context(|| format!("validating {relative_path}"))?;
        checked.push(json!({
            "path": relative_path,
            "kind": vector.expected.kind,
            "transactionId": vector.expected.transaction_id,
            "transactionHash": vector.expected.transaction_hash,
        }));
    }
    let exact_profiles = validate_exact_consensus_profiles()?;
    validate_exact_profiles_vector(repo_root, &exact_profiles)?;
    let exact_interop = validate_exact_interop_vector(repo_root, &exact_profiles)?;
    let kip10 = validate_kip10_exact_template(&exact_profiles)?;
    let batch_interop = validate_batch_interop_vector(repo_root)?;

    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "status": "ok",
            "source": {
                "package": "kaspa-consensus",
                "version": "2.0.1",
                "commit": EXPECTED_SOURCE_COMMIT,
            },
            "vectors": checked,
            "kip10Exact": kip10,
            "exactProfiles": exact_profiles,
            "exactInterop": exact_interop,
            "batchInterop": batch_interop,
        }))?
    );

    Ok(())
}

fn validate_batch_interop_vector(repo_root: &Path) -> Result<serde_json::Value> {
    let relative_path = "vectors/batch/interop-v1.json";
    let contents = fs::read_to_string(repo_root.join(relative_path))
        .with_context(|| format!("reading {relative_path}"))?;
    let vector: serde_json::Value =
        serde_json::from_str(&contents).with_context(|| format!("parsing {relative_path}"))?;

    let channel = &vector["channel"];
    let config = &channel["config"];
    let channel_preimage = concat_bytes(&[
        sha256_bytes(b"kaspa:x402:channel:v1"),
        sha256_bytes(json_string(config, "network")?.as_bytes()),
        sha256_bytes(b"KAS"),
        sha256_bytes(json_string(config, "templateId")?.as_bytes()),
        parse_hex(json_string(config, "clientPublicKey")?, "clientPublicKey")?,
        parse_hex(json_string(config, "serverPublicKey")?, "serverPublicKey")?,
        sha256_bytes(json_string(config, "payTo")?.as_bytes()),
        sha256_bytes(json_string(config, "refundAddress")?.as_bytes()),
        json_u64(config, "refundTimeoutDaa")?.to_le_bytes().to_vec(),
        parse_hex(json_string(config, "salt")?, "salt")?,
    ]);
    expect_eq(
        hex::encode(&channel_preimage),
        json_string(channel, "preimage")?,
        "batch channel preimage",
    )?;
    expect_eq(
        hex::encode(Sha256::digest(&channel_preimage)),
        json_string(channel, "channelId")?,
        "batch channel id",
    )?;

    let escrow = &vector["escrow"];
    let escrow_params = &escrow["params"];
    expect_eq(
        json_string(escrow, "templateId")?,
        json_string(config, "templateId")?,
        "batch escrow template",
    )?;
    for (field, label) in [
        ("clientPublicKey", "batch escrow client key"),
        ("serverPublicKey", "batch escrow server key"),
        ("network", "batch escrow network"),
    ] {
        expect_eq(
            json_string(escrow_params, field)?,
            json_string(config, field)?,
            label,
        )?;
    }
    expect_eq(
        json_string(escrow_params, "timeoutDaa")?,
        json_string(config, "refundTimeoutDaa")?,
        "batch escrow timeout",
    )?;
    validate_address_script_binding(
        json_string(config, "payTo")?,
        json_string(config, "network")?,
        json_string(escrow, "payoutScriptPublicKey")?,
        "batch payTo payout script",
    )?;
    validate_address_script_binding(
        json_string(config, "refundAddress")?,
        json_string(config, "network")?,
        json_string(escrow, "refundScriptPublicKey")?,
        "batch refund address script",
    )?;

    let voucher = &vector["voucher"];
    let voucher_input = &voucher["input"];
    let voucher_outpoint = &voucher_input["outpoint"];
    let voucher_preimage = concat_bytes(&[
        sha256_bytes(b"kaspa:x402:escrow-voucher:v1"),
        sha256_bytes(json_string(voucher_input, "network")?.as_bytes()),
        sha256_bytes(&parse_hex(
            json_string(voucher_input, "activeScriptPublicKey")?,
            "activeScriptPublicKey",
        )?),
        parse_hex(
            json_string(voucher_outpoint, "txid")?,
            "voucher outpoint txid",
        )?,
        json_u32(voucher_outpoint, "index")?.to_le_bytes().to_vec(),
        json_u64(voucher_input, "amount")?.to_le_bytes().to_vec(),
    ]);
    expect_eq(
        hex::encode(&voucher_preimage),
        json_string(voucher, "preimage")?,
        "batch voucher preimage",
    )?;
    let voucher_digest = Sha256::digest(&voucher_preimage);
    expect_eq(
        hex::encode(voucher_digest),
        json_string(voucher, "digest")?,
        "batch voucher digest",
    )?;
    let voucher_public_key = XOnlyPublicKey::from_str(json_string(voucher, "signerPublicKey")?)
        .context("parsing batch voucher signer public key")?;
    expect_eq(
        json_string(voucher, "signerPublicKey")?,
        json_string(config, "clientPublicKey")?,
        "batch voucher signer",
    )?;
    expect_eq(
        json_string(voucher_input, "network")?,
        json_string(config, "network")?,
        "batch voucher network",
    )?;
    expect_eq(
        json_string(voucher_input, "activeScriptPublicKey")?,
        json_string(escrow, "scriptPublicKey")?,
        "batch voucher active script",
    )?;
    let voucher_signature = Signature::from_slice(&parse_hex(
        json_string(voucher, "signature")?,
        "batch voucher signature",
    )?)
    .context("parsing batch voucher Schnorr signature")?;
    let voucher_message = Message::from_digest_slice(&voucher_digest)
        .context("constructing batch voucher message")?;
    SECP256K1
        .verify_schnorr(&voucher_signature, &voucher_message, &voucher_public_key)
        .context("verifying batch voucher Schnorr signature")?;
    let mut mutated_voucher_bytes = voucher_signature.as_ref().to_vec();
    mutated_voucher_bytes[0] ^= 0x01;
    let mutated_voucher = Signature::from_slice(&mutated_voucher_bytes)
        .context("parsing mutated batch voucher signature")?;
    if SECP256K1
        .verify_schnorr(&mutated_voucher, &voucher_message, &voucher_public_key)
        .is_ok()
    {
        return Err(anyhow!("mutated batch voucher signature was accepted"));
    }

    let requirements = &vector["paymentRequirements"];
    let accepted = &requirements["value"];
    let extra = &accepted["extra"];
    for (accepted_field, config_field, label) in [
        ("network", "network", "batch requirements network"),
        ("asset", "asset", "batch requirements asset"),
        ("payTo", "payTo", "batch requirements payTo"),
    ] {
        expect_eq(
            json_string(accepted, accepted_field)?,
            json_string(config, config_field)?,
            label,
        )?;
    }
    for (extra_field, config_field, label) in [
        ("templateId", "templateId", "batch requirements template"),
        (
            "serverPublicKey",
            "serverPublicKey",
            "batch requirements server key",
        ),
        (
            "refundTimeoutDaa",
            "refundTimeoutDaa",
            "batch requirements timeout",
        ),
    ] {
        expect_eq(
            json_string(extra, extra_field)?,
            json_string(config, config_field)?,
            label,
        )?;
    }
    let requirements_preimage = concat_bytes(&[
        sha256_bytes(b"kaspa:x402:batch-payment-requirements:v1"),
        sha256_bytes(b"batch-settlement"),
        sha256_bytes(json_string(accepted, "network")?.as_bytes()),
        sha256_bytes(b"KAS"),
        json_u64(accepted, "amount")?.to_le_bytes().to_vec(),
        sha256_bytes(json_string(accepted, "payTo")?.as_bytes()),
        json_u64_number(accepted, "maxTimeoutSeconds")?
            .to_le_bytes()
            .to_vec(),
        sha256_bytes(b"kaspa-escrow-v1"),
        sha256_bytes(json_string(extra, "templateId")?.as_bytes()),
        parse_hex(json_string(extra, "serverPublicKey")?, "serverPublicKey")?,
        json_u64(extra, "minDepositSompi")?.to_le_bytes().to_vec(),
        json_u64(extra, "refundTimeoutDaa")?.to_le_bytes().to_vec(),
    ]);
    expect_eq(
        hex::encode(&requirements_preimage),
        json_string(requirements, "preimage")?,
        "batch payment requirements preimage",
    )?;
    let requirements_hash = Sha256::digest(&requirements_preimage);
    expect_eq(
        hex::encode(requirements_hash),
        json_string(requirements, "sha256")?,
        "batch payment requirements hash",
    )?;

    let commitment = &vector["commitment"];
    let commitment_input = &commitment["input"];
    let active_outpoint = &commitment_input["activeOutpoint"];
    let commitment_voucher = &commitment_input["voucher"];
    let before = json_u64(commitment_input, "chargedCumulativeBefore")?;
    let charged = json_u64(commitment_input, "chargedAmount")?;
    let after = json_u64(commitment_input, "chargedCumulativeAfter")?;
    if before.checked_add(charged) != Some(after) {
        return Err(anyhow!("batch commitment cumulative accounting mismatch"));
    }
    if &commitment_input["accepted"] != accepted {
        return Err(anyhow!("batch commitment payment requirements mismatch"));
    }
    expect_eq(
        json_string(commitment_input, "channelId")?,
        json_string(channel, "channelId")?,
        "batch commitment channel id",
    )?;
    if active_outpoint != &voucher_input["outpoint"] {
        return Err(anyhow!("batch commitment active outpoint mismatch"));
    }
    if commitment_voucher["amount"] != voucher_input["amount"]
        || commitment_voucher["signature"] != voucher["signature"]
    {
        return Err(anyhow!("batch commitment voucher mismatch"));
    }
    let commitment_preimage = concat_bytes(&[
        sha256_bytes(b"kaspa:x402:batch-commitment:v1"),
        parse_hex(json_string(commitment_input, "channelId")?, "channelId")?,
        parse_hex(
            json_string(commitment_input, "requestFingerprint")?,
            "requestFingerprint",
        )?,
        requirements_hash.to_vec(),
        parse_hex(
            json_string(active_outpoint, "txid")?,
            "active outpoint txid",
        )?,
        json_u32(active_outpoint, "index")?.to_le_bytes().to_vec(),
        json_u64(commitment_voucher, "amount")?
            .to_le_bytes()
            .to_vec(),
        sha256_bytes(&parse_hex(
            json_string(commitment_voucher, "signature")?,
            "commitment voucher signature",
        )?),
        charged.to_le_bytes().to_vec(),
        before.to_le_bytes().to_vec(),
        after.to_le_bytes().to_vec(),
        json_u64(commitment_input, "claimedCumulativeAmount")?
            .to_le_bytes()
            .to_vec(),
    ]);
    expect_eq(
        hex::encode(&commitment_preimage),
        json_string(commitment, "preimage")?,
        "batch commitment preimage",
    )?;
    expect_eq(
        hex::encode(Sha256::digest(&commitment_preimage)),
        json_string(commitment, "commitmentId")?,
        "batch commitment id",
    )?;

    for (script_field, hash_field) in [
        ("payoutScriptPublicKey", "payoutScriptPublicKeyHash"),
        ("refundScriptPublicKey", "refundScriptPublicKeyHash"),
    ] {
        let script = parse_hex(json_string(escrow, script_field)?, script_field)?;
        expect_eq(
            hex::encode(Sha256::digest(script)),
            json_string(&escrow["params"], hash_field)?,
            hash_field,
        )?;
    }

    let claim_transaction = validate_batch_transaction_reference(
        repo_root,
        &vector["transactions"]["claim"],
        "claim",
        "vectors/tx-v1/batch-claim.json",
        escrow,
        voucher,
        commitment_input,
        config,
    )?;
    let refund_transaction = validate_batch_transaction_reference(
        repo_root,
        &vector["transactions"]["refund"],
        "refund",
        "vectors/tx-v1/batch-refund.json",
        escrow,
        voucher,
        commitment_input,
        config,
    )?;
    if refund_transaction["input"]["activeOutpoint"]
        != claim_transaction["expected"]["continuation"]["outpoint"]
    {
        return Err(anyhow!("batch refund continuation outpoint mismatch"));
    }
    expect_eq(
        json_string(&refund_transaction["input"], "activeAmount")?,
        json_string(&claim_transaction["expected"]["continuation"], "amount")?,
        "batch refund continuation amount",
    )?;
    expect_eq(
        json_string(&refund_transaction["input"], "activeScriptPublicKey")?,
        json_string(
            &claim_transaction["expected"]["continuation"],
            "scriptPublicKey",
        )?,
        "batch refund continuation script",
    )?;

    Ok(json!({
        "vector": relative_path,
        "channel": "sha256-matched",
        "voucher": "sha256-and-schnorr-matched",
        "mutatedVoucherSignature": "rejected",
        "paymentRequirements": "sha256-matched",
        "commitment": "sha256-matched",
        "claimAndRefund": "full-consensus-and-script-execution-validated",
    }))
}

fn validate_address_script_binding(
    address: &str,
    network: &str,
    expected_script_public_key: &str,
    label: &str,
) -> Result<()> {
    let address = Address::try_from(address).with_context(|| format!("parsing {label} address"))?;
    let expected_prefix = match network {
        "kaspa:mainnet" => Prefix::Mainnet,
        "kaspa:testnet-10" => Prefix::Testnet,
        _ => {
            return Err(anyhow!(
                "unsupported batch interoperability network {network}"
            ));
        }
    };
    if address.prefix != expected_prefix {
        return Err(anyhow!("{label} address prefix does not match {network}"));
    }
    expect_eq(
        serialize_script_public_key(&pay_to_address_script(&address)),
        expected_script_public_key,
        label,
    )
}

#[allow(clippy::too_many_arguments)]
fn validate_batch_transaction_reference(
    repo_root: &Path,
    reference: &serde_json::Value,
    name: &str,
    expected_path: &str,
    escrow: &serde_json::Value,
    voucher: &serde_json::Value,
    commitment_input: &serde_json::Value,
    config: &serde_json::Value,
) -> Result<serde_json::Value> {
    expect_eq(
        json_string(reference, "path")?,
        expected_path,
        &format!("batch {name} path"),
    )?;
    let bytes = fs::read(repo_root.join(expected_path))
        .with_context(|| format!("reading {expected_path}"))?;
    expect_eq(
        hex::encode(Sha256::digest(&bytes)),
        json_string(reference, "sha256")?,
        &format!("batch {name} file hash"),
    )?;
    let transaction: serde_json::Value =
        serde_json::from_slice(&bytes).with_context(|| format!("parsing {expected_path}"))?;
    let expected = &transaction["expected"];
    for field in ["transactionId", "transactionHash"] {
        expect_eq(
            json_string(expected, field)?,
            json_string(reference, field)?,
            &format!("batch {name} {field}"),
        )?;
    }
    if expected["sighash"] != reference["sighash"] {
        return Err(anyhow!("batch {name} sighash evidence mismatch"));
    }
    if expected["compute"] != reference["compute"] {
        return Err(anyhow!("batch {name} compute evidence mismatch"));
    }

    let input = &transaction["input"];
    expect_eq(
        json_string(input, "activeScriptPublicKey")?,
        json_string(escrow, "scriptPublicKey")?,
        &format!("batch {name} active script"),
    )?;
    expect_eq(
        json_string(input, "redeemScript")?,
        json_string(escrow, "redeemScript")?,
        &format!("batch {name} redeem script"),
    )?;

    if name == "claim" {
        if input["activeOutpoint"] != voucher["input"]["outpoint"] {
            return Err(anyhow!("batch claim active outpoint mismatch"));
        }
        expect_eq(
            json_string(input, "serverOutputScriptPublicKey")?,
            json_string(escrow, "payoutScriptPublicKey")?,
            "batch claim payout script",
        )?;
        expect_eq(
            json_string(input, "voucherSignature")?,
            json_string(voucher, "signature")?,
            "batch claim voucher signature",
        )?;
        expect_eq(
            json_string(input, "expectedPayoutScriptPublicKeyHash")?,
            json_string(&escrow["params"], "payoutScriptPublicKeyHash")?,
            "batch claim payout hash",
        )?;
        expect_eq(
            json_string(input, "claimAmount")?,
            json_string(commitment_input, "chargedCumulativeAfter")?,
            "batch claim amount",
        )?;
    } else {
        expect_eq(
            json_string(input, "refundOutputScriptPublicKey")?,
            json_string(escrow, "refundScriptPublicKey")?,
            "batch refund output script",
        )?;
        expect_eq(
            json_string(input, "expectedRefundScriptPublicKeyHash")?,
            json_string(&escrow["params"], "refundScriptPublicKeyHash")?,
            "batch refund output hash",
        )?;
        expect_eq(
            json_string(input, "timeoutDaa")?,
            json_string(config, "refundTimeoutDaa")?,
            "batch refund timeout",
        )?;
    }

    Ok(transaction)
}

fn concat_bytes(parts: &[Vec<u8>]) -> Vec<u8> {
    let capacity = parts.iter().map(Vec::len).sum();
    let mut bytes = Vec::with_capacity(capacity);
    for part in parts {
        bytes.extend_from_slice(part);
    }
    bytes
}

fn sha256_bytes(bytes: &[u8]) -> Vec<u8> {
    Sha256::digest(bytes).to_vec()
}

fn validate_exact_consensus_profiles() -> Result<serde_json::Value> {
    let standard = build_standard_native_exact()?;
    let additive = build_additive_exact()?;

    validate_full_consensus(&standard.0, &standard.1)
        .context("standard-native exact must pass full consensus validation")?;
    validate_standard_native_profile(
        &standard.0,
        &standard.1,
        &standard.2,
        EXACT_PAYMENT_SOMPI,
        500_000,
    )
    .context("standard-native exact must satisfy the x402 profile")?;

    validate_full_consensus(&additive.0, &additive.1)
        .context("additive exact must pass full consensus validation")?;
    validate_additive_profile(&additive.0, &additive.1, EXACT_PAYMENT_SOMPI, 500_000)
        .context("additive exact must satisfy the x402 profile")?;

    let mut standard_bad_signature = standard.0.clone();
    standard_bad_signature.inputs[0].signature_script[1] ^= 0x01;
    expect_consensus_rejection(
        &standard_bad_signature,
        &standard.1,
        "standard mutated payer signature",
    )?;

    let mut standard_overpayment = standard.0.clone();
    standard_overpayment.outputs[0].value += 1;
    standard_overpayment.outputs[1].value -= 1;
    resign_standard(&mut standard_overpayment, &standard.1)?;
    validate_full_consensus(&standard_overpayment, &standard.1)
        .context("standard overpayment mutation should remain consensus-valid")?;
    expect_profile_rejection(
        validate_standard_native_profile(
            &standard_overpayment,
            &standard.1,
            &standard.2,
            EXACT_PAYMENT_SOMPI,
            500_000,
        ),
        "standard merchant overpayment",
    )?;

    let mut standard_excessive_fee = standard.0.clone();
    standard_excessive_fee.outputs[1].value -= 1_000_000;
    resign_standard(&mut standard_excessive_fee, &standard.1)?;
    validate_full_consensus(&standard_excessive_fee, &standard.1)
        .context("standard excessive-fee mutation should remain consensus-valid")?;
    expect_profile_rejection(
        validate_standard_native_profile(
            &standard_excessive_fee,
            &standard.1,
            &standard.2,
            EXACT_PAYMENT_SOMPI,
            500_000,
        ),
        "standard excessive fee",
    )?;

    let mut standard_duplicate_payment = standard.0.clone();
    standard_duplicate_payment.outputs[1].value -= 1_000_000;
    standard_duplicate_payment
        .outputs
        .push(TransactionOutput::new(1_000_000, standard.2.clone()));
    resign_standard(&mut standard_duplicate_payment, &standard.1)?;
    validate_full_consensus(&standard_duplicate_payment, &standard.1)
        .context("second standard merchant output should remain consensus-valid")?;
    expect_profile_rejection(
        validate_standard_native_profile(
            &standard_duplicate_payment,
            &standard.1,
            &standard.2,
            EXACT_PAYMENT_SOMPI,
            500_000,
        ),
        "standard duplicate merchant output",
    )?;

    let mut standard_payload = standard.0.clone();
    standard_payload.payload = vec![1];
    resign_standard(&mut standard_payload, &standard.1)?;
    validate_full_consensus(&standard_payload, &standard.1)
        .context("native payload mutation should remain consensus-valid")?;
    expect_profile_rejection(
        validate_standard_native_profile(
            &standard_payload,
            &standard.1,
            &standard.2,
            EXACT_PAYMENT_SOMPI,
            500_000,
        ),
        "standard native payload",
    )?;

    let mut standard_bad_context = standard.0.clone();
    standard_bad_context.gas = 1;
    expect_consensus_rejection(
        &standard_bad_context,
        &standard.1,
        "standard native transaction with gas",
    )?;

    let standard_wrong_mass = standard.0.clone();
    standard_wrong_mass.set_storage_mass(standard_wrong_mass.storage_mass() + 1);
    expect_consensus_rejection(
        &standard_wrong_mass,
        &standard.1,
        "standard wrong storage mass",
    )?;

    let mut standard_wrong_version = standard.0.clone();
    standard_wrong_version.version = 1;
    expect_consensus_rejection(
        &standard_wrong_version,
        &standard.1,
        "standard transaction with v1/sigop mismatch",
    )?;

    let mut additive_bad_signature = additive.0.clone();
    additive_bad_signature.inputs[1].signature_script[1] ^= 0x01;
    expect_consensus_rejection(
        &additive_bad_signature,
        &additive.1,
        "additive mutated payer signature",
    )?;

    let mut additive_underbudget = additive.0.clone();
    additive_underbudget.inputs[1].compute_commit = ComputeBudget(9).into();
    expect_consensus_rejection(
        &additive_underbudget,
        &additive.1,
        "additive under-budget payer input",
    )?;

    let mut additive_overbudget = additive.0.clone();
    additive_overbudget.inputs[0].compute_commit = ComputeBudget(1).into();
    validate_full_consensus(&additive_overbudget, &additive.1)
        .context("excessive KIP-10 compute budget should remain consensus-valid")?;
    expect_profile_rejection(
        validate_additive_profile(
            &additive_overbudget,
            &additive.1,
            EXACT_PAYMENT_SOMPI,
            500_000,
        ),
        "additive excessive compute budget",
    )?;

    let mut additive_below_threshold = additive.0.clone();
    let below_threshold_value = additive.1[0].amount + 10_000_000 - 1;
    let returned_to_change = additive_below_threshold.outputs[0].value - below_threshold_value;
    additive_below_threshold.outputs[0].value = below_threshold_value;
    additive_below_threshold.outputs[1].value += returned_to_change;
    resign_additive(&mut additive_below_threshold, &additive.1)?;
    expect_consensus_rejection(
        &additive_below_threshold,
        &additive.1,
        "additive continuation below KIP-10 threshold",
    )?;

    let mut additive_wrong_script = additive.0.clone();
    additive_wrong_script.outputs[0].script_public_key = additive.2.clone();
    resign_additive(&mut additive_wrong_script, &additive.1)?;
    expect_consensus_rejection(
        &additive_wrong_script,
        &additive.1,
        "additive continuation with wrong script",
    )?;

    let mut additive_excessive_delta = additive.0.clone();
    additive_excessive_delta.outputs[0].value += 1;
    additive_excessive_delta.outputs[1].value -= 1;
    resign_additive(&mut additive_excessive_delta, &additive.1)?;
    validate_full_consensus(&additive_excessive_delta, &additive.1).context(
        "excessive additive delta should remain consensus-valid because KIP-10 is a lower bound",
    )?;
    expect_profile_rejection(
        validate_additive_profile(
            &additive_excessive_delta,
            &additive.1,
            EXACT_PAYMENT_SOMPI,
            500_000,
        ),
        "additive excessive delta",
    )?;

    let mut additive_duplicate_payment = additive.0.clone();
    additive_duplicate_payment.outputs[1].value -= 1_000_000;
    additive_duplicate_payment
        .outputs
        .push(TransactionOutput::new(
            1_000_000,
            additive.0.outputs[0].script_public_key.clone(),
        ));
    resign_additive(&mut additive_duplicate_payment, &additive.1)?;
    validate_full_consensus(&additive_duplicate_payment, &additive.1)
        .context("separate additive merchant output should be consensus-valid")?;
    expect_profile_rejection(
        validate_additive_profile(
            &additive_duplicate_payment,
            &additive.1,
            EXACT_PAYMENT_SOMPI,
            500_000,
        ),
        "additive duplicate merchant benefit",
    )?;

    let mut forged_entries = standard.1.clone();
    forged_entries[0].amount += 1;
    expect_consensus_rejection(&standard.0, &forged_entries, "forged standard UTXO amount")?;

    let mut additive_wrong_version = additive.0.clone();
    additive_wrong_version.version = 0;
    expect_consensus_rejection(
        &additive_wrong_version,
        &additive.1,
        "additive transaction with v0/compute-budget mismatch",
    )?;

    let additive_wrong_mass = additive.0.clone();
    additive_wrong_mass.set_storage_mass(additive_wrong_mass.storage_mass() + 1);
    expect_consensus_rejection(
        &additive_wrong_mass,
        &additive.1,
        "additive wrong storage mass",
    )?;

    Ok(json!({
        "standardNative": exact_evidence("standard-native", &standard.0, &standard.1, &[measure_input_units(&standard.0, &standard.1, 0)?]),
        "additive": exact_evidence(
            "additive",
            &additive.0,
            &additive.1,
            &[
                measure_input_units(&additive.0, &additive.1, 0)?,
                measure_input_units(&additive.0, &additive.1, 1)?,
            ],
        ),
        "mutations": {
            "standardBadSignature": "consensus-rejected",
            "standardMerchantOverpayment": "profile-rejected",
            "standardExcessiveFee": "profile-rejected",
            "standardDuplicateMerchantOutput": "profile-rejected-after-consensus-acceptance",
            "standardPayload": "profile-rejected-after-consensus-acceptance",
            "standardGas": "consensus-rejected",
            "standardWrongMass": "consensus-rejected",
            "standardWrongVersion": "consensus-rejected",
            "additiveBadSignature": "consensus-rejected",
            "additiveUnderbudget": "consensus-rejected",
            "additiveOverbudget": "profile-rejected-after-consensus-acceptance",
            "additiveBelowThreshold": "consensus-rejected",
            "additiveWrongScript": "consensus-rejected",
            "additiveExcessiveDelta": "profile-rejected-after-consensus-acceptance",
            "additiveDuplicateMerchantBenefit": "profile-rejected-after-consensus-acceptance",
            "forgedUtxoAmount": "consensus-rejected",
            "additiveWrongMass": "consensus-rejected",
            "additiveWrongVersion": "consensus-rejected",
        },
    }))
}

fn build_standard_native_exact() -> Result<(Transaction, Vec<UtxoEntry>, ScriptPublicKey)> {
    let payer_key = [7_u8; 32];
    let merchant_key = [8_u8; 32];
    let payer_spk = p2pk_script(&payer_key)?;
    let merchant_spk = p2pk_script(&merchant_key)?;
    let input_amount = 50_000_000;
    let entries = vec![UtxoEntry::new(
        input_amount,
        payer_spk.clone(),
        0,
        false,
        None,
    )];
    let input = TransactionInput::new(
        TransactionOutpoint::new(TransactionId::from_bytes([0x70; 32]), 0),
        vec![],
        u64::MAX,
        1,
    );
    let outputs = vec![
        TransactionOutput::new(EXACT_PAYMENT_SOMPI, merchant_spk.clone()),
        TransactionOutput::new(
            input_amount - EXACT_PAYMENT_SOMPI - EXACT_FEE_SOMPI,
            payer_spk,
        ),
    ];
    let mut tx = Transaction::new(
        0,
        vec![input],
        outputs,
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    resign_standard(&mut tx, &entries)?;
    Ok((tx, entries, merchant_spk))
}

fn build_additive_exact() -> Result<(Transaction, Vec<UtxoEntry>, ScriptPublicKey)> {
    let payer_key = [7_u8; 32];
    let owner_key = [9_u8; 32];
    let payer_spk = p2pk_script(&payer_key)?;
    let owner = Keypair::from_seckey_slice(SECP256K1, &owner_key)
        .context("constructing additive owner key")?;
    let mut builder = ScriptBuilder::new();
    let redeem_script = builder
        .add_op(OpIf)?
        .add_data(&owner.x_only_public_key().0.serialize())?
        .add_op(OpCheckSig)?
        .add_op(OpElse)?
        .add_ops(&[
            OpTxInputIndex,
            OpTxInputSpk,
            OpTxInputIndex,
            OpTxOutputSpk,
            OpEqualVerify,
            OpTxInputIndex,
            OpTxOutputAmount,
        ])?
        .add_i64(10_000_000)?
        .add_ops(&[OpSub, OpTxInputIndex, OpTxInputAmount, OpGreaterThanOrEqual])?
        .add_op(OpEndIf)?
        .drain();
    let head_spk = pay_to_script_hash_script(&redeem_script);
    let mut witness = ScriptBuilder::new();
    let head_signature_script = witness.add_op(OpFalse)?.add_data(&redeem_script)?.drain();
    let head_amount = 100_000_000;
    let payer_amount = 40_000_000;
    let entries = vec![
        UtxoEntry::new(head_amount, head_spk.clone(), 0, false, None),
        UtxoEntry::new(payer_amount, payer_spk.clone(), 0, false, None),
    ];
    let inputs = vec![
        TransactionInput::new_with_compute_budget(
            TransactionOutpoint::new(TransactionId::from_bytes([0x71; 32]), 0),
            head_signature_script,
            u64::MAX,
            10,
        ),
        TransactionInput::new_with_compute_budget(
            TransactionOutpoint::new(TransactionId::from_bytes([0x72; 32]), 1),
            vec![],
            u64::MAX,
            10,
        ),
    ];
    let outputs = vec![
        TransactionOutput::new(head_amount + EXACT_PAYMENT_SOMPI, head_spk),
        TransactionOutput::new(
            payer_amount - EXACT_PAYMENT_SOMPI - EXACT_FEE_SOMPI,
            payer_spk.clone(),
        ),
    ];
    let mut tx = Transaction::new(1, inputs, outputs, 0, SubnetworkId::default(), 0, vec![]);
    resign_additive(&mut tx, &entries)?;

    let head_units = measure_input_units(&tx, &entries, 0)?;
    let payer_units = measure_input_units(&tx, &entries, 1)?;
    tx.inputs[0].compute_commit = ComputeBudget::checked_covering_script_units(head_units.into())
        .ok_or_else(|| anyhow!("KIP-10 compute budget exceeds uint16"))?
        .into();
    tx.inputs[1].compute_commit = ComputeBudget::checked_covering_script_units(payer_units.into())
        .ok_or_else(|| anyhow!("payer compute budget exceeds uint16"))?
        .into();
    resign_additive(&mut tx, &entries)?;
    Ok((tx, entries, payer_spk))
}

fn p2pk_script(private_key: &[u8; 32]) -> Result<ScriptPublicKey> {
    let key = Keypair::from_seckey_slice(SECP256K1, private_key)
        .context("constructing deterministic P2PK key")?;
    let mut script = Vec::with_capacity(34);
    script.push(32);
    script.extend_from_slice(&key.x_only_public_key().0.serialize());
    script.push(OpCheckSig);
    Ok(ScriptPublicKey::new(0, script.into()))
}

fn transaction_validator() -> TransactionValidator {
    let params = TESTNET_PARAMS;
    TransactionValidator::new(
        params.max_tx_inputs,
        params.max_tx_outputs,
        params.max_signature_script_len(),
        params.max_script_public_key_len,
        params.coinbase_payload_script_public_key_max_len,
        params.coinbase_maturity(),
        params.ghostdag_k(),
        Default::default(),
        MassCalculator::new_with_consensus_params(&params),
        params.toccata_activation,
        params.mass_per_sig_op,
    )
}

fn validate_full_consensus(tx: &Transaction, entries: &[UtxoEntry]) -> Result<u64> {
    let validator = transaction_validator();
    validator
        .validate_tx_in_isolation(tx)
        .map_err(|error| anyhow!(error.to_string()))?;
    let populated = PopulatedTransaction::new(tx, entries.to_vec());
    validator
        .validate_populated_transaction_and_get_fee(
            &populated,
            POST_TOCCATA_DAA_SCORE,
            POST_TOCCATA_DAA_SCORE,
            TxValidationFlags::Full,
            None,
            None,
        )
        .map_err(|error| anyhow!(error.to_string()))
}

fn expect_consensus_rejection(tx: &Transaction, entries: &[UtxoEntry], label: &str) -> Result<()> {
    if validate_full_consensus(tx, entries).is_ok() {
        return Err(anyhow!("{label} was accepted by full consensus validation"));
    }
    Ok(())
}

fn expect_profile_rejection(result: Result<()>, label: &str) -> Result<()> {
    if result.is_ok() {
        return Err(anyhow!("{label} was accepted by the exact profile"));
    }
    Ok(())
}

fn resign_standard(tx: &mut Transaction, entries: &[UtxoEntry]) -> Result<()> {
    tx.inputs[0].signature_script.clear();
    set_storage_mass(tx, entries)?;
    tx.finalize();
    let populated = PopulatedTransaction::new(tx, entries.to_vec());
    tx.inputs[0].signature_script = deterministic_signature(&populated, 0, &[7_u8; 32])?;
    tx.finalize();
    Ok(())
}

fn resign_additive(tx: &mut Transaction, entries: &[UtxoEntry]) -> Result<()> {
    tx.inputs[1].signature_script.clear();
    set_storage_mass(tx, entries)?;
    tx.finalize();
    let populated = PopulatedTransaction::new(tx, entries.to_vec());
    tx.inputs[1].signature_script = deterministic_signature(&populated, 1, &[7_u8; 32])?;
    tx.finalize();
    Ok(())
}

fn deterministic_signature(
    tx: &impl VerifiableTransaction,
    input_index: usize,
    private_key: &[u8; 32],
) -> Result<Vec<u8>> {
    let hash = calc_schnorr_signature_hash(
        tx,
        input_index,
        SIG_HASH_ALL,
        &SigHashReusedValuesUnsync::new(),
    );
    let message = Message::from_digest_slice(hash.as_bytes().as_slice())
        .context("constructing exact sighash message")?;
    let key = Keypair::from_seckey_slice(SECP256K1, private_key)
        .context("constructing exact signing key")?;
    let signature = SECP256K1.sign_schnorr_no_aux_rand(&message, &key);
    Ok(std::iter::once(65_u8)
        .chain(signature.as_ref().iter().copied())
        .chain(std::iter::once(SIG_HASH_ALL.to_u8()))
        .collect())
}

fn set_storage_mass(tx: &Transaction, entries: &[UtxoEntry]) -> Result<()> {
    let populated = PopulatedTransaction::new(tx, entries.to_vec());
    let storage_mass = MassCalculator::new_with_consensus_params(&TESTNET_PARAMS)
        .calc_contextual_masses(&populated)
        .ok_or_else(|| anyhow!("exact transaction storage mass is not calculable"))?
        .storage_mass;
    tx.set_storage_mass(storage_mass);
    Ok(())
}

fn measure_input_units(tx: &Transaction, entries: &[UtxoEntry], input_index: usize) -> Result<u64> {
    let populated = PopulatedTransaction::new(tx, entries.to_vec());
    let cache = Cache::new(64);
    let reused = SigHashReusedValuesUnsync::new();
    let ctx = EngineCtx::new(&cache).with_reused(&reused);
    let flags = EngineFlags {
        covenants_enabled: true,
        sigop_script_units: Gram(TESTNET_PARAMS.mass_per_sig_op).into(),
    };
    let mut engine = TxScriptEngine::from_transaction_input(
        &populated,
        &populated.tx.inputs[input_index],
        input_index,
        &entries[input_index],
        ctx,
        flags,
    );
    engine
        .execute()
        .map_err(|error| anyhow!(error.to_string()))?;
    Ok(engine.used_script_units().0)
}

fn validate_standard_native_profile(
    tx: &Transaction,
    entries: &[UtxoEntry],
    merchant_script: &ScriptPublicKey,
    amount: u64,
    maximum_fee: u64,
) -> Result<()> {
    if tx.version != 0
        || tx.subnetwork_id != SubnetworkId::default()
        || tx.gas != 0
        || !tx.payload.is_empty()
        || tx.lock_time != 0
    {
        return Err(anyhow!(
            "standard-native transaction context is not canonical"
        ));
    }
    if !(1..=2).contains(&tx.outputs.len())
        || tx.outputs[0].script_public_key != *merchant_script
        || tx.outputs[0].value != amount
    {
        return Err(anyhow!(
            "standard-native merchant output is not the exact advertised payment"
        ));
    }
    if tx.outputs.iter().any(|output| output.covenant.is_some()) {
        return Err(anyhow!(
            "standard-native outputs must not contain covenants"
        ));
    }
    if tx
        .outputs
        .iter()
        .skip(1)
        .any(|output| output.script_public_key == *merchant_script)
    {
        return Err(anyhow!(
            "standard-native transaction contains a second merchant output"
        ));
    }
    if tx
        .inputs
        .iter()
        .any(|input| input.compute_commit.sig_op_count() != Some(1))
    {
        return Err(anyhow!(
            "standard-native inputs must commit exactly one sigop"
        ));
    }
    let fee = transaction_fee(tx, entries)?;
    if fee > maximum_fee {
        return Err(anyhow!("standard-native fee exceeds policy"));
    }
    Ok(())
}

fn validate_additive_profile(
    tx: &Transaction,
    entries: &[UtxoEntry],
    amount: u64,
    maximum_fee: u64,
) -> Result<()> {
    if tx.version != 1
        || tx.subnetwork_id != SubnetworkId::default()
        || tx.gas != 0
        || !tx.payload.is_empty()
        || tx.lock_time != 0
    {
        return Err(anyhow!("additive transaction context is not canonical"));
    }
    if tx.inputs.len() < 2 || !(1..=2).contains(&tx.outputs.len()) {
        return Err(anyhow!("additive transaction shape is not canonical"));
    }
    let head = entries
        .first()
        .ok_or_else(|| anyhow!("additive head UTXO is missing"))?;
    let successor = &tx.outputs[0];
    if successor.script_public_key != head.script_public_key
        || successor.value != head.amount + amount
    {
        return Err(anyhow!(
            "additive successor delta is not the exact advertised payment"
        ));
    }
    if tx.outputs.iter().any(|output| output.covenant.is_some()) {
        return Err(anyhow!(
            "additive outputs must not contain covenant bindings"
        ));
    }
    if tx
        .outputs
        .iter()
        .skip(1)
        .any(|output| output.script_public_key == head.script_public_key)
    {
        return Err(anyhow!(
            "additive transaction contains a separate merchant-controlled output"
        ));
    }
    for (index, input) in tx.inputs.iter().enumerate() {
        let units = measure_input_units(tx, entries, index)?;
        let expected = ComputeBudget::checked_covering_script_units(units.into())
            .ok_or_else(|| anyhow!("input {index} requires an excessive compute budget"))?;
        if input.compute_commit.compute_budget() != Some(u16::from(expected)) {
            return Err(anyhow!(
                "input {index} compute budget is not the smallest covering commitment"
            ));
        }
    }
    let fee = transaction_fee(tx, entries)?;
    if fee > maximum_fee {
        return Err(anyhow!("additive fee exceeds policy"));
    }
    Ok(())
}

fn transaction_fee(tx: &Transaction, entries: &[UtxoEntry]) -> Result<u64> {
    let input_total = entries
        .iter()
        .try_fold(0_u64, |total, entry| total.checked_add(entry.amount))
        .ok_or_else(|| anyhow!("input amount overflow"))?;
    let output_total = tx
        .outputs
        .iter()
        .try_fold(0_u64, |total, output| total.checked_add(output.value))
        .ok_or_else(|| anyhow!("output amount overflow"))?;
    input_total
        .checked_sub(output_total)
        .ok_or_else(|| anyhow!("outputs exceed inputs"))
}

fn exact_evidence(
    profile: &str,
    tx: &Transaction,
    entries: &[UtxoEntry],
    script_units: &[u64],
) -> serde_json::Value {
    let calculator = MassCalculator::new_with_consensus_params(&TESTNET_PARAMS);
    let non_contextual = calculator.calc_non_contextual_masses(tx);
    let transaction_id = tx.id().to_string();
    let txid = if tx.version == 0 {
        json!({
            "algorithm": "blake2b-256-keyed",
            "domain": "TransactionID",
            "preimage": hex::encode(tx_hashing::transaction_v0_id_preimage(tx)),
            "digest": transaction_id,
        })
    } else {
        let payload_digest = tx_hashing::payload_digest(&tx.payload);
        let rest_preimage = tx_hashing::transaction_v1_rest_preimage(tx);
        let rest_digest = tx_hashing::v1_rest_digest(tx);
        let mut preimage = Vec::with_capacity(64);
        preimage.extend_from_slice(&payload_digest.as_bytes());
        preimage.extend_from_slice(&rest_digest.as_bytes());
        json!({
            "algorithm": "blake3-256-keyed",
            "payloadDomain": "PayloadDigest",
            "payloadDigest": payload_digest.to_string(),
            "restDomain": "TransactionRest",
            "restPreimage": hex::encode(rest_preimage),
            "restDigest": rest_digest.to_string(),
            "domain": "TransactionV1Id",
            "preimage": hex::encode(preimage),
            "digest": transaction_id,
        })
    };
    json!({
        "profile": profile,
        "version": tx.version,
        "transactionId": transaction_id,
        "txid": txid,
        "transactionHash": tx_hashing::hash(tx).to_string(),
        "amount": EXACT_PAYMENT_SOMPI.to_string(),
        "fee": transaction_fee(tx, entries).expect("validated exact fee").to_string(),
        "storageMass": tx.storage_mass().to_string(),
        "computeMass": non_contextual.compute_mass.to_string(),
        "transientMass": non_contextual.transient_mass.to_string(),
        "estimatedSerializedSize": transaction_estimated_serialized_size(tx),
        "scriptUnits": script_units,
        "computeCommitments": tx.inputs.iter().map(|input| {
            input.compute_commit.compute_budget().map(u16::from)
                .map(|value| json!({ "computeBudget": value }))
                .unwrap_or_else(|| json!({ "sigOpCount": input.compute_commit.sig_op_count().unwrap_or_default() }))
        }).collect::<Vec<_>>(),
        "inputs": tx.inputs.len(),
        "outputs": tx.outputs.len(),
        "transaction": {
            "version": tx.version,
            "lockTime": tx.lock_time.to_string(),
            "subnetworkId": hex::encode(tx.subnetwork_id.as_bytes()),
            "gas": tx.gas.to_string(),
            "payload": hex::encode(&tx.payload),
            "storageMass": tx.storage_mass().to_string(),
            "inputs": tx.inputs.iter().enumerate().map(|(index, input)| json!({
                "previousOutpoint": {
                    "txid": input.previous_outpoint.transaction_id.to_string(),
                    "index": input.previous_outpoint.index,
                },
                "signatureScript": hex::encode(&input.signature_script),
                "sequence": input.sequence.to_string(),
                "sigOpCount": input.compute_commit.sig_op_count(),
                "computeBudget": input.compute_commit.compute_budget(),
                "utxo": {
                    "amount": entries[index].amount.to_string(),
                    "scriptPublicKey": serialize_script_public_key(&entries[index].script_public_key),
                    "blockDaaScore": entries[index].block_daa_score.to_string(),
                    "isCoinbase": entries[index].is_coinbase,
                },
            })).collect::<Vec<_>>(),
            "outputs": tx.outputs.iter().map(|output| json!({
                "amount": output.value.to_string(),
                "scriptPublicKey": serialize_script_public_key(&output.script_public_key),
                "covenant": output.covenant.as_ref().map(|binding| json!({
                    "authorizingInput": binding.authorizing_input,
                    "covenantId": binding.covenant_id.to_string(),
                })),
            })).collect::<Vec<_>>(),
        },
    })
}

fn serialize_script_public_key(script_public_key: &ScriptPublicKey) -> String {
    format!(
        "{:02x}{:02x}{}",
        script_public_key.version() >> 8,
        script_public_key.version() & 0xff,
        hex::encode(script_public_key.script())
    )
}

fn validate_exact_profiles_vector(repo_root: &Path, actual: &serde_json::Value) -> Result<()> {
    if env::var("KASPA_X402_GENERATE_EXACT_VECTORS").as_deref() == Ok("1") {
        return Ok(());
    }
    let relative_path = "vectors/exact/consensus-profiles.json";
    let contents = fs::read_to_string(repo_root.join(relative_path))
        .with_context(|| format!("reading {relative_path}"))?;
    let vector: serde_json::Value =
        serde_json::from_str(&contents).with_context(|| format!("parsing {relative_path}"))?;
    if vector["expected"] != *actual {
        return Err(anyhow!(
            "{relative_path} does not match the full Rust consensus oracle; regenerate exact vectors"
        ));
    }
    Ok(())
}

fn validate_exact_interop_vector(
    repo_root: &Path,
    exact_profiles: &serde_json::Value,
) -> Result<serde_json::Value> {
    if env::var("KASPA_X402_GENERATE_EXACT_VECTORS").as_deref() == Ok("1") {
        return Ok(json!({ "status": "skipped-while-generating-consensus-vector" }));
    }
    let relative_path = "vectors/exact/interop-v1.json";
    let contents = fs::read_to_string(repo_root.join(relative_path))
        .with_context(|| format!("reading {relative_path}"))?;
    let vector: serde_json::Value =
        serde_json::from_str(&contents).with_context(|| format!("parsing {relative_path}"))?;

    for (vector_key, profile_key) in [
        ("standardNative", "standardNative"),
        ("additive", "additive"),
    ] {
        let interop = &vector["transactionEncoding"]["profiles"][vector_key];
        let consensus = &exact_profiles[profile_key];
        if interop["transactionId"] != consensus["transactionId"]
            || interop["txid"] != consensus["txid"]
        {
            return Err(anyhow!(
                "{relative_path} {vector_key} transaction-id evidence does not match the Rust consensus oracle"
            ));
        }
    }

    let requirements = &vector["paymentRequirements"];
    let requirements_preimage = json_string(requirements, "canonicalJsonUtf8")?;
    expect_eq(
        hex::encode(Sha256::digest(requirements_preimage.as_bytes())),
        json_string(requirements, "sha256")?,
        "paymentRequirements SHA-256",
    )?;

    let authorization = &vector["requestAuthorization"];
    let authorization_preimage = json_string(authorization, "canonicalJsonUtf8")?;
    let authorization_digest = Sha256::digest(authorization_preimage.as_bytes());
    expect_eq(
        hex::encode(authorization_digest),
        json_string(authorization, "sha256")?,
        "requestAuthorization SHA-256",
    )?;
    let public_key = XOnlyPublicKey::from_str(json_string(authorization, "signerPublicKey")?)
        .context("parsing request-authorization signer public key")?;
    let signature = Signature::from_slice(&parse_hex(
        json_string(authorization, "signature")?,
        "requestAuthorization.signature",
    )?)
    .context("parsing request-authorization Schnorr signature")?;
    let message = Message::from_digest_slice(&authorization_digest)
        .context("constructing request-authorization message")?;
    SECP256K1
        .verify_schnorr(&signature, &message, &public_key)
        .context("verifying request-authorization Schnorr signature")?;

    Ok(json!({
        "vector": relative_path,
        "transactionIds": "rust-consensus-matched",
        "paymentRequirementsHash": "sha256-matched",
        "requestAuthorization": "sha256-and-schnorr-matched",
    }))
}

fn validate_kip10_exact_template(exact_profiles: &serde_json::Value) -> Result<serde_json::Value> {
    let additive = &exact_profiles["additive"];
    let head_input = &additive["transaction"]["inputs"][0];
    let signature_script = json_string(head_input, "signatureScript")?;
    let expected_script = signature_script.strip_prefix("0035").ok_or_else(|| {
        anyhow!("additive exact head witness must use OP_FALSE and a 53-byte redeem script push")
    })?;
    let script = parse_hex(expected_script, "borrowRedeemScript")?;
    if script.len() < 34 || script[0] != OpIf || script[1] != 32 {
        return Err(anyhow!(
            "additive exact consensus vector does not contain a canonical KIP-10 owner key prefix"
        ));
    }
    let owner_public_key: [u8; 32] = script[2..34]
        .try_into()
        .map_err(|_| anyhow!("KIP-10 owner public key must be 32 bytes"))?;
    let threshold = 10_000_000_i64;
    let mut builder = ScriptBuilder::new();
    let canonical_script = builder
        .add_op(OpIf)?
        .add_data(&owner_public_key)?
        .add_op(OpCheckSig)?
        .add_op(OpElse)?
        .add_ops(&[
            OpTxInputIndex,
            OpTxInputSpk,
            OpTxInputIndex,
            OpTxOutputSpk,
            OpEqualVerify,
            OpTxInputIndex,
            OpTxOutputAmount,
        ])?
        .add_i64(threshold)?
        .add_ops(&[OpSub, OpTxInputIndex, OpTxInputAmount, OpGreaterThanOrEqual])?
        .add_op(OpEndIf)?
        .drain();
    expect_eq(
        hex::encode(&canonical_script),
        expected_script,
        "KIP-10 redeem script",
    )?;

    let script_public_key = pay_to_script_hash_script(&canonical_script);
    let serialized_script_public_key = format!(
        "{:02x}{:02x}{}",
        script_public_key.version() >> 8,
        script_public_key.version() & 0xff,
        hex::encode(script_public_key.script())
    );
    expect_eq(
        serialized_script_public_key.as_str(),
        json_string(&head_input["utxo"], "scriptPublicKey")?,
        "KIP-10 script public key",
    )?;

    let input_amount = json_string(&head_input["utxo"], "amount")?
        .parse::<u64>()
        .context("parsing head amount")?;
    let head_outpoint = &head_input["previousOutpoint"];
    let mut signature_builder = ScriptBuilder::new();
    let signature_script = signature_builder
        .add_op(OpFalse)?
        .add_data(&canonical_script)?
        .drain();
    let input = TransactionInput::new_with_compute_budget(
        TransactionOutpoint {
            transaction_id: TransactionId::from_str(json_string(head_outpoint, "txid")?)
                .context("parsing head outpoint txid")?,
            index: json_u32(head_outpoint, "index")?,
        },
        signature_script,
        0,
        10,
    );
    let utxo = UtxoEntry::new(input_amount, script_public_key.clone(), 0, false, None);
    let output = TransactionOutput {
        value: input_amount + threshold as u64,
        script_public_key: script_public_key.clone(),
        covenant: None,
    };
    let tx = Transaction::new(
        1,
        vec![input.clone()],
        vec![output],
        0,
        Default::default(),
        0,
        vec![],
    );
    execute_kip10_input(&tx, &utxo).context("canonical KIP-10 borrower path must execute")?;

    let mut below_threshold = tx.clone();
    below_threshold.outputs[0].value -= 1;
    if execute_kip10_input(&below_threshold, &utxo).is_ok() {
        return Err(anyhow!(
            "KIP-10 borrower path accepted a continuation below threshold"
        ));
    }

    let mut wrong_script = tx.clone();
    wrong_script.outputs[0].script_public_key = ScriptPublicKey::new(0, vec![0x51].into());
    if execute_kip10_input(&wrong_script, &utxo).is_ok() {
        return Err(anyhow!(
            "KIP-10 borrower path accepted a different continuation script"
        ));
    }

    Ok(json!({
        "vector": "vectors/exact/consensus-profiles.json",
        "template": "kaspa-x402-kip10-additive-v1",
        "redeemScript": expected_script,
        "scriptPublicKey": serialized_script_public_key,
        "thresholdSompi": threshold.to_string(),
        "fullConsensusValidated": true,
        "validContinuation": "accepted",
        "belowThreshold": "rejected",
        "wrongContinuationScript": "rejected",
    }))
}

fn json_string<'a>(value: &'a serde_json::Value, field: &str) -> Result<&'a str> {
    value[field]
        .as_str()
        .ok_or_else(|| anyhow!("{field} must be a string"))
}

fn json_u32(value: &serde_json::Value, field: &str) -> Result<u32> {
    let number = value[field]
        .as_u64()
        .ok_or_else(|| anyhow!("{field} must be an unsigned integer"))?;
    number
        .try_into()
        .map_err(|_| anyhow!("{field} exceeds uint32"))
}

fn json_u64(value: &serde_json::Value, field: &str) -> Result<u64> {
    json_string(value, field)?
        .parse::<u64>()
        .with_context(|| format!("{field} must be a uint64 decimal string"))
}

fn json_u64_number(value: &serde_json::Value, field: &str) -> Result<u64> {
    value[field]
        .as_u64()
        .ok_or_else(|| anyhow!("{field} must be an unsigned integer"))
}

fn execute_kip10_input(tx: &Transaction, utxo: &UtxoEntry) -> Result<()> {
    let populated = PopulatedTransaction::new(tx, vec![utxo.clone()]);
    let cache = Cache::new(64);
    let reused = SigHashReusedValuesUnsync::new();
    let ctx = EngineCtx::new(&cache).with_reused(&reused);
    let mut engine = TxScriptEngine::from_transaction_input(
        &populated,
        &populated.tx.inputs[0],
        0,
        utxo,
        ctx,
        Default::default(),
    );
    engine.execute().map_err(|error| anyhow!(error.to_string()))
}

fn read_vector(path: &Path) -> Result<VectorFile> {
    let contents =
        fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    serde_json::from_str(&contents).with_context(|| format!("parsing {}", path.display()))
}

fn validate_vector(vector: &VectorFile) -> Result<()> {
    if !vector.kind.starts_with("tx-v1-") {
        return Err(anyhow!("unexpected vector kind {}", vector.kind));
    }
    let tx = build_transaction(&vector.expected.transaction)?;
    let populated =
        PopulatedTransaction::new(&tx, build_utxo_entries(&vector.expected.transaction)?);

    expect_eq(
        tx.id().to_string(),
        vector.expected.transaction_id.as_str(),
        "transactionId",
    )?;
    let canonical_transaction_hash = tx_hashing::hash(&tx).to_string();
    expect_eq(
        canonical_transaction_hash.as_str(),
        vector.expected.transaction_hash.as_str(),
        "transactionHash",
    )?;
    expect_eq(
        vector.expected.serialized_transaction.as_str(),
        vector.expected.hash.preimage.as_str(),
        "serializedTransaction",
    )?;
    expect_eq(
        vector.expected.hash.digest.as_str(),
        vector.expected.transaction_hash.as_str(),
        "hash.digest",
    )?;
    let hash_preimage = parse_hex(&vector.expected.hash.preimage, "hash.preimage")?;
    expect_eq(
        TransactionHash::hash(&hash_preimage).to_string(),
        vector.expected.transaction_hash.as_str(),
        "hash.preimage digest",
    )?;
    expect_eq(
        tx_hashing::payload_digest(&tx.payload).to_string(),
        vector.expected.txid.payload_digest.as_str(),
        "txid.payloadDigest",
    )?;
    expect_eq(
        hex::encode(tx_hashing::transaction_v1_rest_preimage(&tx)),
        vector.expected.txid.rest_preimage.as_str(),
        "txid.restPreimage",
    )?;
    expect_eq(
        tx_hashing::v1_rest_digest(&tx).to_string(),
        vector.expected.txid.rest_digest.as_str(),
        "txid.restDigest",
    )?;
    expect_eq(
        calc_schnorr_signature_hash(
            &populated,
            vector.expected.sighash.input_index,
            SIG_HASH_ALL,
            &SigHashReusedValuesUnsync::new(),
        )
        .to_string(),
        vector.expected.sighash.digest.as_str(),
        "sighash.digest",
    )?;
    expect_eq(
        hex::encode(sighash_all_preimage(
            &populated,
            vector.expected.sighash.input_index,
        )?),
        vector.expected.sighash.preimage.as_str(),
        "sighash.preimage",
    )?;
    expect_eq(
        tx.storage_mass().to_string(),
        vector.expected.transaction.mass.as_str(),
        "transaction.mass",
    )?;
    expect_eq(
        transaction_estimated_serialized_size(&tx).to_string(),
        vector
            .expected
            .transaction
            .estimated_serialized_size
            .to_string()
            .as_str(),
        "transaction.estimatedSerializedSize",
    )?;

    let calculated_storage_mass = MassCalculator::new(0, 0, STORAGE_MASS_PARAMETER)
        .calc_contextual_masses(&populated)
        .ok_or_else(|| anyhow!("storage mass is not calculable"))?
        .storage_mass;
    expect_eq(
        calculated_storage_mass.to_string(),
        vector.expected.transaction.mass.as_str(),
        "canonical storage mass",
    )?;

    for (index, input) in vector.expected.transaction.inputs.iter().enumerate() {
        let actual = tx.inputs[index]
            .compute_commit
            .compute_budget()
            .ok_or_else(|| anyhow!("input {index} is missing compute budget"))?;
        if actual != input.compute_budget {
            return Err(anyhow!(
                "input {index} compute budget mismatch: expected {}, actual {}",
                input.compute_budget,
                actual
            ));
        }
    }
    for (index, output) in vector.expected.transaction.outputs.iter().enumerate() {
        if output.covenant.is_some() != tx.outputs[index].covenant.is_some() {
            return Err(anyhow!("output {index} covenant presence mismatch"));
        }
    }
    validate_compute_budget_hash_boundary(&vector.expected)?;

    let batch_entries = build_utxo_entries(&vector.expected.transaction)?;
    validate_full_consensus(&tx, &batch_entries)
        .context("batch transaction must pass full populated-UTXO consensus validation")?;
    execute_populated_input(&tx, &batch_entries, 0)
        .context("batch covenant input must execute with the committed signatures")?;
    let mut bad_signature = tx.clone();
    let signature_byte = bad_signature.inputs[0]
        .signature_script
        .get_mut(1)
        .ok_or_else(|| anyhow!("batch signature script is unexpectedly empty"))?;
    *signature_byte ^= 0x01;
    if execute_populated_input(&bad_signature, &batch_entries, 0).is_ok() {
        return Err(anyhow!("batch covenant accepted a mutated signature"));
    }

    Ok(())
}

fn execute_populated_input(
    tx: &Transaction,
    entries: &[UtxoEntry],
    input_index: usize,
) -> Result<()> {
    let populated = PopulatedTransaction::new(tx, entries.to_vec());
    let input = populated
        .tx
        .inputs
        .get(input_index)
        .ok_or_else(|| anyhow!("input index is out of range"))?;
    let utxo = entries
        .get(input_index)
        .ok_or_else(|| anyhow!("UTXO index is out of range"))?;
    let cache = Cache::new(64);
    let reused = SigHashReusedValuesUnsync::new();
    let ctx = EngineCtx::new(&cache).with_reused(&reused);
    let mut engine = TxScriptEngine::from_transaction_input(
        &populated,
        input,
        input_index,
        utxo,
        ctx,
        EngineFlags {
            covenants_enabled: true,
            ..Default::default()
        },
    );
    engine.execute().map_err(|error| anyhow!(error.to_string()))
}

fn sighash_all_preimage(
    populated: &PopulatedTransaction<'_>,
    input_index: usize,
) -> Result<Vec<u8>> {
    if input_index >= populated.tx.inputs.len() {
        return Err(anyhow!("sighash input index is out of range"));
    }

    let hash_type = SIG_HASH_ALL;
    let reused_values = SigHashReusedValuesUnsync::new();
    let input = populated.populated_input(input_index);
    let tx = populated.tx;
    let mut writer = PreimageWriter::new();
    writer
        .write_u16(tx.version)
        .write_hash(previous_outputs_hash(tx, hash_type, &reused_values))
        .write_hash(sequences_hash(tx, hash_type, &reused_values));

    if tx.version < 1 {
        writer.write_hash(sig_op_counts_hash(tx, hash_type, &reused_values));
    }

    write_outpoint_preimage(&mut writer, input.0.previous_outpoint);
    write_script_public_key_preimage(&mut writer, &input.1.script_public_key);
    writer.write_u64(input.1.amount).write_u64(input.0.sequence);

    if tx.version < 1 {
        writer.write_u8(input.0.compute_commit.sig_op_count().unwrap_or(0));
    }

    writer
        .write_hash(outputs_hash(tx, hash_type, &reused_values, input_index))
        .write_u64(tx.lock_time)
        .bytes(tx.subnetwork_id)
        .write_u64(tx.gas)
        .write_hash(payload_hash(tx, &reused_values))
        .write_u8(hash_type.to_u8());

    Ok(writer.finish())
}

fn write_outpoint_preimage(writer: &mut PreimageWriter, outpoint: TransactionOutpoint) {
    writer
        .bytes(outpoint.transaction_id)
        .write_u32(outpoint.index);
}

fn write_script_public_key_preimage(
    writer: &mut PreimageWriter,
    script_public_key: &ScriptPublicKey,
) {
    writer
        .write_u16(script_public_key.version())
        .write_var_bytes(script_public_key.script());
}

struct PreimageWriter {
    bytes: Vec<u8>,
}

impl PreimageWriter {
    fn new() -> Self {
        Self { bytes: Vec::new() }
    }

    fn bytes(&mut self, bytes: impl AsRef<[u8]>) -> &mut Self {
        self.bytes.extend_from_slice(bytes.as_ref());
        self
    }

    fn write_hash(&mut self, hash: Hash) -> &mut Self {
        self.bytes(hash)
    }

    fn finish(self) -> Vec<u8> {
        self.bytes
    }
}

impl HasherBase for PreimageWriter {
    fn update<A: AsRef<[u8]>>(&mut self, data: A) -> &mut Self {
        self.bytes(data)
    }
}

fn validate_compute_budget_hash_boundary(artifact: &Artifact) -> Result<()> {
    let original_tx = build_transaction(&artifact.transaction)?;
    let original_populated =
        PopulatedTransaction::new(&original_tx, build_utxo_entries(&artifact.transaction)?);
    let original_sighash = calc_schnorr_signature_hash(
        &original_populated,
        artifact.sighash.input_index,
        SIG_HASH_ALL,
        &SigHashReusedValuesUnsync::new(),
    );
    let mut mutated_artifact = artifact.transaction.clone();
    let first_input = mutated_artifact
        .inputs
        .first_mut()
        .ok_or_else(|| anyhow!("transaction has no inputs"))?;
    first_input.compute_budget = first_input.compute_budget.saturating_add(1);
    if first_input.compute_budget == artifact.transaction.inputs[0].compute_budget {
        return Err(anyhow!("cannot mutate compute budget without overflow"));
    }
    let mutated_tx = build_transaction(&mutated_artifact)?;
    let mutated_populated =
        PopulatedTransaction::new(&mutated_tx, build_utxo_entries(&mutated_artifact)?);
    let mutated_sighash = calc_schnorr_signature_hash(
        &mutated_populated,
        artifact.sighash.input_index,
        SIG_HASH_ALL,
        &SigHashReusedValuesUnsync::new(),
    );

    if mutated_tx.id() != original_tx.id() {
        return Err(anyhow!("compute budget mutation changed txid"));
    }
    if tx_hashing::hash(&mutated_tx) == tx_hashing::hash(&original_tx) {
        return Err(anyhow!("compute budget mutation did not change tx hash"));
    }
    if mutated_sighash != original_sighash {
        return Err(anyhow!("compute budget mutation changed v1 sighash"));
    }

    Ok(())
}

fn build_transaction(artifact: &ArtifactTransaction) -> Result<Transaction> {
    let inputs = artifact
        .inputs
        .iter()
        .map(|input| {
            Ok(TransactionInput::new_with_compute_budget(
                TransactionOutpoint::new(
                    parse_hash(&input.previous_outpoint.txid)?,
                    input.previous_outpoint.index,
                ),
                parse_hex(&input.signature_script, "signatureScript")?,
                parse_u64(&input.sequence, "sequence")?,
                input.compute_budget,
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    let outputs = artifact
        .outputs
        .iter()
        .map(build_output)
        .collect::<Result<Vec<_>>>()?;
    Ok(Transaction::new_with_mass(
        artifact.version,
        inputs,
        outputs,
        parse_u64(&artifact.lock_time, "lockTime")?,
        parse_subnetwork_id(&artifact.subnetwork_id)?,
        parse_u64(&artifact.gas, "gas")?,
        parse_hex(&artifact.payload, "payload")?,
        parse_u64(&artifact.mass, "mass")?,
    ))
}

fn build_output(output: &ArtifactOutput) -> Result<TransactionOutput> {
    let covenant = output
        .covenant
        .as_ref()
        .map(|covenant| -> Result<CovenantBinding> {
            Ok(CovenantBinding::new(
                covenant.authorizing_input,
                parse_hash(&covenant.covenant_id)?,
            ))
        })
        .transpose()?;
    Ok(TransactionOutput::with_covenant(
        parse_u64(&output.amount, "output.amount")?,
        parse_script_public_key(&output.script_public_key)?,
        covenant,
    ))
}

fn build_utxo_entries(artifact: &ArtifactTransaction) -> Result<Vec<UtxoEntry>> {
    artifact
        .inputs
        .iter()
        .map(|input| {
            Ok(UtxoEntry::new(
                parse_u64(&input.utxo.amount, "utxo.amount")?,
                parse_script_public_key(&input.utxo.script_public_key)?,
                parse_u64(&input.utxo.block_daa_score, "utxo.blockDaaScore")?,
                input.utxo.is_coinbase,
                None,
            ))
        })
        .collect()
}

fn parse_script_public_key(hex: &str) -> Result<ScriptPublicKey> {
    let bytes = parse_hex(hex, "scriptPublicKey")?;
    if bytes.len() < 2 {
        return Err(anyhow!("scriptPublicKey must contain a uint16 version"));
    }
    let version = u16::from_le_bytes([bytes[0], bytes[1]]);
    Ok(ScriptPublicKey::from_vec(version, bytes[2..].to_vec()))
}

fn parse_subnetwork_id(hex: &str) -> Result<SubnetworkId> {
    let bytes = parse_hex(hex, "subnetworkId")?;
    let bytes: [u8; 20] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| anyhow!("subnetworkId must be 20 bytes"))?;
    Ok(SubnetworkId::from_bytes(bytes))
}

fn parse_hash(hex: &str) -> Result<Hash> {
    Hash::from_str(hex).map_err(|error| anyhow!("invalid hash {hex}: {error}"))
}

fn parse_hex(hex: &str, label: &str) -> Result<Vec<u8>> {
    hex::decode(hex).map_err(|error| anyhow!("{label} must be hex bytes: {error}"))
}

fn parse_u64(value: &str, label: &str) -> Result<u64> {
    value
        .parse::<u64>()
        .map_err(|error| anyhow!("{label} must fit in u64: {error}"))
}

fn expect_eq(actual: impl AsRef<str>, expected: impl AsRef<str>, label: &str) -> Result<()> {
    let actual = actual.as_ref();
    let expected = expected.as_ref();
    if actual != expected {
        return Err(anyhow!(
            "{label} mismatch\nexpected: {expected}\nactual:   {actual}"
        ));
    }
    Ok(())
}
