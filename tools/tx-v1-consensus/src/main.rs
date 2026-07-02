use anyhow::{anyhow, Context, Result};
use kaspa_consensus_core::{
    hashing::{
        sighash::{
            calc_schnorr_signature_hash, outputs_hash, payload_hash, previous_outputs_hash, sequences_hash,
            sig_op_counts_hash, SigHashReusedValuesUnsync,
        },
        sighash_type::SIG_HASH_ALL,
        tx as tx_hashing,
        HasherExtensions,
    },
    mass::{transaction_estimated_serialized_size, MassCalculator},
    subnets::SubnetworkId,
    tx::{
        CovenantBinding, PopulatedTransaction, ScriptPublicKey, Transaction, TransactionInput, TransactionOutpoint,
        TransactionOutput, UtxoEntry, VerifiableTransaction,
    },
};
use kaspa_hashes::{Hash, Hasher, HasherBase, TransactionHash};
use serde::Deserialize;
use serde_json::json;
use std::{env, fs, path::Path, str::FromStr};

const EXPECTED_SOURCE_COMMIT: &str = "ef1a093bcf8560fe05221b56f0c896f97e7d8d77";
const STORAGE_MASS_PARAMETER: u64 = 1_000_000_000_000;

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
    let repo_root = env::args().nth(1).context("usage: tx-v1-consensus <repo-root>")?;
    let repo_root = Path::new(&repo_root);
    let vector_paths = [
        "vectors/tx-v1/batch-claim.json",
        "vectors/tx-v1/batch-refund.json",
        "vectors/tx-v1/upto-settlement.json",
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

    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "status": "ok",
            "source": {
                "package": "kaspa-consensus-core",
                "version": "2.0.1",
                "commit": EXPECTED_SOURCE_COMMIT,
            },
            "vectors": checked,
        }))?
    );

    Ok(())
}

fn read_vector(path: &Path) -> Result<VectorFile> {
    let contents = fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    serde_json::from_str(&contents).with_context(|| format!("parsing {}", path.display()))
}

fn validate_vector(vector: &VectorFile) -> Result<()> {
    if !vector.kind.starts_with("tx-v1-") {
        return Err(anyhow!("unexpected vector kind {}", vector.kind));
    }
    let tx = build_transaction(&vector.expected.transaction)?;
    let populated = PopulatedTransaction::new(&tx, build_utxo_entries(&vector.expected.transaction)?);

    expect_eq(tx.id().to_string(), vector.expected.transaction_id.as_str(), "transactionId")?;
    let canonical_transaction_hash = tx_hashing::hash(&tx).to_string();
    expect_eq(canonical_transaction_hash.as_str(), vector.expected.transaction_hash.as_str(), "transactionHash")?;
    expect_eq(vector.expected.serialized_transaction.as_str(), vector.expected.hash.preimage.as_str(), "serializedTransaction")?;
    expect_eq(vector.expected.hash.digest.as_str(), vector.expected.transaction_hash.as_str(), "hash.digest")?;
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
        hex::encode(sighash_all_preimage(&populated, vector.expected.sighash.input_index)?),
        vector.expected.sighash.preimage.as_str(),
        "sighash.preimage",
    )?;
    expect_eq(tx.storage_mass().to_string(), vector.expected.transaction.mass.as_str(), "transaction.mass")?;
    expect_eq(
        transaction_estimated_serialized_size(&tx).to_string(),
        vector.expected.transaction.estimated_serialized_size.to_string().as_str(),
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
            return Err(anyhow!("input {index} compute budget mismatch: expected {}, actual {}", input.compute_budget, actual));
        }
    }
    for (index, output) in vector.expected.transaction.outputs.iter().enumerate() {
        if output.covenant.is_some() != tx.outputs[index].covenant.is_some() {
            return Err(anyhow!("output {index} covenant presence mismatch"));
        }
    }
    validate_compute_budget_hash_boundary(&vector.expected)?;

    Ok(())
}

fn sighash_all_preimage(populated: &PopulatedTransaction<'_>, input_index: usize) -> Result<Vec<u8>> {
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
    writer.bytes(outpoint.transaction_id).write_u32(outpoint.index);
}

fn write_script_public_key_preimage(writer: &mut PreimageWriter, script_public_key: &ScriptPublicKey) {
    writer.write_u16(script_public_key.version()).write_var_bytes(script_public_key.script());
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
    let original_populated = PopulatedTransaction::new(&original_tx, build_utxo_entries(&artifact.transaction)?);
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
    let mutated_populated = PopulatedTransaction::new(&mutated_tx, build_utxo_entries(&mutated_artifact)?);
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
                TransactionOutpoint::new(parse_hash(&input.previous_outpoint.txid)?, input.previous_outpoint.index),
                parse_hex(&input.signature_script, "signatureScript")?,
                parse_u64(&input.sequence, "sequence")?,
                input.compute_budget,
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    let outputs = artifact.outputs.iter().map(build_output).collect::<Result<Vec<_>>>()?;
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
            Ok(CovenantBinding::new(covenant.authorizing_input, parse_hash(&covenant.covenant_id)?))
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
    value.parse::<u64>().map_err(|error| anyhow!("{label} must fit in u64: {error}"))
}

fn expect_eq(actual: impl AsRef<str>, expected: impl AsRef<str>, label: &str) -> Result<()> {
    let actual = actual.as_ref();
    let expected = expected.as_ref();
    if actual != expected {
        return Err(anyhow!("{label} mismatch\nexpected: {expected}\nactual:   {actual}"));
    }
    Ok(())
}
