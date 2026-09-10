use kaspa_consensus::consensus::test_consensus::TestConsensus;
use kaspa_consensus_core::{
    api::ConsensusApi,
    coinbase::MinerData,
    config::{ConfigBuilder, params::SIMNET_PARAMS},
    subnets::SUBNETWORK_ID_NATIVE,
    tx::{ScriptPublicKey, Transaction, TransactionInput, TransactionOutput},
};
use kaspa_hashes::Hash;
use serde_json::json;

async fn insert(c: &TestConsensus, n: u64, parent: Hash, txs: Vec<Transaction>) -> Hash {
    let hash = Hash::from_u64_word(n);
    let block = c.build_utxo_valid_block_with_parents(
        hash,
        vec![parent],
        MinerData::new(ScriptPublicKey::from_vec(0, vec![0x51]), vec![]),
        txs,
    );
    let status = c
        .validate_and_insert_block(block.to_immutable())
        .virtual_state_task
        .await
        .unwrap();
    assert!(status.has_block_body());
    hash
}

fn has(c: &TestConsensus, id: Hash) -> bool {
    c.get_virtual_utxos(None, 10_000, false)
        .iter()
        .any(|(outpoint, _)| outpoint.transaction_id == id)
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let config = ConfigBuilder::new(SIMNET_PARAMS)
        .skip_proof_of_work()
        .edit_consensus_params(|params| params.blockrate.coinbase_maturity = 2)
        .build();
    let consensus = TestConsensus::new(&config);
    let handles = consensus.init();
    let mut common = config.genesis.hash;
    for n in 1..=12 {
        common = insert(&consensus, n, common, vec![]).await;
    }
    let (funding, entry) = consensus
        .get_virtual_utxos(None, 10_000, false)
        .into_iter()
        .find(|(_, entry)| entry.block_daa_score + 2 < consensus.get_virtual_daa_score())
        .unwrap();
    let spend = |fee| {
        Transaction::new(
            1,
            vec![TransactionInput::new_with_compute_budget(
                funding,
                vec![],
                u64::MAX,
                0,
            )],
            vec![TransactionOutput::new(
                entry.amount - fee,
                ScriptPublicKey::from_vec(0, vec![0x51]),
            )],
            0,
            SUBNETWORK_ID_NATIVE,
            0,
            vec![],
        )
    };
    let initial = spend(1_000);
    let replacement = spend(2_000);
    let initial_block = insert(&consensus, 100, common, vec![initial.clone()]).await;
    let initial_tip = insert(&consensus, 101, initial_block, vec![]).await;
    assert!(has(&consensus, initial.id()));
    assert!(!has(&consensus, replacement.id()));
    let before_sink = consensus.get_sink();
    assert_eq!(before_sink, initial_tip);
    let initial_acceptance = consensus.get_block_acceptance_data(initial_tip).unwrap();
    assert!(initial_acceptance.iter().any(|block| {
        block
            .accepted_transactions
            .iter()
            .any(|transaction| transaction.transaction_id == initial.id())
    }));

    let mut replacement_tip = insert(&consensus, 200, common, vec![replacement.clone()]).await;
    for n in 201..=206 {
        replacement_tip = insert(&consensus, n, replacement_tip, vec![]).await;
    }
    assert_eq!(consensus.get_sink(), replacement_tip);
    assert!(!has(&consensus, initial.id()));
    assert!(has(&consensus, replacement.id()));
    assert!(
        !consensus
            .get_virtual_utxos(None, 10_000, false)
            .iter()
            .any(|(outpoint, _)| *outpoint == funding)
    );
    let path = consensus
        .get_virtual_chain_from_block(before_sink, None)
        .unwrap();
    assert!(path.removed.contains(&initial_tip));
    assert!(path.added.contains(&replacement_tip));
    let accepted = path
        .added
        .iter()
        .flat_map(|hash| {
            consensus
                .get_block_acceptance_data(*hash)
                .unwrap()
                .as_ref()
                .clone()
        })
        .flat_map(|block| block.accepted_transactions)
        .map(|transaction| transaction.transaction_id)
        .collect::<Vec<_>>();
    assert!(accepted.contains(&replacement.id()));
    assert!(!accepted.contains(&initial.id()));

    let (refund_input, refund_entry) = consensus
        .get_virtual_utxos(None, 10_000, false)
        .into_iter()
        .find(|(_, entry)| {
            entry.is_coinbase && entry.block_daa_score + 2 < consensus.get_virtual_daa_score()
        })
        .unwrap();
    let mut boundary_block = consensus.build_utxo_valid_block_with_parents(
        Hash::from_u64_word(300),
        vec![replacement_tip],
        MinerData::new(ScriptPublicKey::from_vec(0, vec![0x51]), vec![]),
        vec![],
    );
    let lock_daa = boundary_block.header.daa_score;
    let refund = Transaction::new(
        1,
        vec![TransactionInput::new_with_compute_budget(
            refund_input,
            vec![],
            0,
            0,
        )],
        vec![TransactionOutput::new(
            refund_entry.amount - 1_000,
            ScriptPublicKey::from_vec(0, vec![0x51]),
        )],
        lock_daa,
        SUBNETWORK_ID_NATIVE,
        0,
        vec![],
    );
    boundary_block.transactions.push(refund.clone());
    boundary_block.header.hash_merkle_root =
        kaspa_consensus_core::merkle::calc_hash_merkle_root(boundary_block.transactions.iter());
    let boundary_error = consensus
        .validate_and_insert_block(boundary_block.to_immutable())
        .virtual_state_task
        .await
        .unwrap_err();
    assert!(
        format!("{boundary_error:?}").contains("NotFinalized"),
        "{boundary_error:?}"
    );
    let advance = insert(&consensus, 301, replacement_tip, vec![]).await;
    let refund_block = insert(&consensus, 302, advance, vec![refund.clone()]).await;
    assert_eq!(
        consensus.get_header(refund_block).unwrap().daa_score,
        lock_daa + 1
    );
    assert!(has(&consensus, refund.id()));

    let report = json!({
        "passed": true,
        "headerFinality": {
            "lockTime": lock_daa,
            "rejectedContainingDaa": lock_daa,
            "rejection": format!("{boundary_error:?}"),
            "acceptedContainingDaa": lock_daa + 1,
            "transactionId": refund.id().to_string(),
            "scope": "Generic tx-v1 non-final input with DAA lock time, not x402 refund covenant script"
        },
        "consensusCommit": "c338d495bec29e4dc8b5149f99e8db6fa916ed4a",
        "scope": "Isolated canonical TestConsensus simnet DAG; proof of work skipped, deterministic block hashes, coinbase maturity reduced to 2; full consensus virtual-state/UTXO/acceptance processing; no node RPC or public network",
        "fundingOutpoint": format!("{}:{}", funding.transaction_id, funding.index),
        "initialSpend": initial.id().to_string(),
        "replacementSpend": replacement.id().to_string(),
        "beforeSink": before_sink.to_string(),
        "afterSink": replacement_tip.to_string(),
        "removedChainBlocks": path.removed.iter().map(ToString::to_string).collect::<Vec<_>>(),
        "addedChainBlocks": path.added.iter().map(ToString::to_string).collect::<Vec<_>>(),
        "assertions": [
            "initial spend output present and replacement absent before reorg",
            "initial spend included in selected chain acceptance data",
            "selected sink changes to competing branch",
            "initial spend output removed and conflicting replacement output created",
            "funding outpoint remains spent",
            "virtual chain path explicitly removes old branch and adds new branch",
            "new selected chain acceptance contains replacement and excludes initial spend"
        ]
    });
    consensus.shutdown(handles);
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
}
