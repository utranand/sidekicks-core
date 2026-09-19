# Repo-root scripts — presence and activation

> Framework rule `rule.repo-root-scripts-lifecycle`, owned by `sk-publish-core`.
> Inspect with `sidekicks framework show rule.repo-root-scripts-lifecycle`;
> disable with `sidekicks framework disable rule.repo-root-scripts-lifecycle`.

Every repo-root script travels into a forged core for root-structure parity, preserving its
relative path and executable mode. The forge attributes each script as `root-structure`.
A copied file does not activate a capability: only declared owners may activate hooks or expose
a script as a managed capability. Optional skills may leave their copied scripts dormant.

When adding a script, declare its owner and dependencies and update all supported host adapters
if it implements a hook. When removing a script, update every live caller and ownership claim in
the same change. Remove deliberately retired, owned implementations; park only unclaimed scripts
under `scripts/legacy/` with their reason. Never keep a second live forge implementation.

The canonical forge and release implementation belongs in `lib/core-forge/`; assets travel with
that implementation. Changes must run on macOS and Windows with one code path and include
verification that copied scripts cannot silently enable hooks owned by absent skills.
