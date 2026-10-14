# Covenant compiler release boundary

Scope: findings #11, #13 and #28. Exercise the public generation/check CLIs and
the SDK release gate. Tests precede implementation; demo and package publication
changes are outside this patch.

Required failures and controls:

1. Release checking without a pinned compiler must fail, rather than accepting
   internally consistent committed bytecode as independent compilation proof.
2. Escrow `--check` must reject either stale fixture or generated module without
   rewriting any artifact. Both generators must reject unknown arguments.
3. Root manifests, lockfiles, ignored Cargo configuration, untracked executable
   inputs, hidden-index source edits and changes after inspection must not enter
   the compiler that executes. Export authenticated Git objects, not a worktree.
4. Inherited Cargo configuration, rustc wrappers/flags, dependency overrides and
   target caches must not replace the pinned compiler or its build inputs.
5. A subdirectory or wrong revision must not masquerade as the pinned root.
   Symlinks, gitlinks and unsafe paths in exported inputs must fail closed.
6. Constructor/state variants must agree with independently compiled bytecode;
   checks must compare both JSON/ABI and the generated runtime module.
7. Clean generation and checks must preserve committed covenant bytes and
   identities. Compilation failure must leave existing artifacts untouched.
8. Actual pinned SilverScript compilation must reproduce both committed
   covenants; a controlled external compiler alone cannot establish that fact.

Run `node protocol/scripts/proof-covenant-compiler-e2e.mjs --out <report.json>`
for the adversarial CLI proof. Add `--real` with `SILVERSCRIPT_DIR` pointing to
the pinned checkout to include real compiler reproduction. The report identifies
the controlled compiler boundary separately from actual compilation evidence.
