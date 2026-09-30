# Escrow guard failure modes

Recorded before adding the behavioral consensus checks.

- A claim redirects the provider payout or covenant-binds that payout.
- A claim or top-up creates an extra output in the same lineage, or consumes
  an extra input in that lineage, breaking singleton accounting.
- A top-up redirects the client's change or covenant-binds that change.
- A refund redirects the client's refund or retains a covenant-bound output
  instead of terminating the lineage.

For each mutation, recompute storage mass and transaction signatures while
retaining the valid voucher. Require script execution to reject the transaction
and require the full consensus validator to reject it. First accept re-signed
claim, top-up, and refund controls so a broken signing helper cannot make every
negative case pass. These checks execute the pinned compiled contract; fixture
reproducibility separately binds that bytecode to the checked source.
