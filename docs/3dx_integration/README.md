# 3DEXPERIENCE integration docs: moved

The parts catalog and its 3DEXPERIENCE (3DX) integration now live in the
[plm_bridge](https://github.com/cacton77/plm_bridge) repository (private), and
so do these documents:

- `docs/backends/dx3.md`: what the tenant's REST API actually does,
  verified live (formerly `TENANT_API_FINDINGS.md`).
- `docs/backends/dx3/`: the design documents, the setup checklist, the API
  walk-through, and the REST tour notebook (formerly here).

Configuration is unchanged: the `DX_*` variables in `.env` (see `.env.example`),
plus `PLM_BACKENDS` (default `dx3`).
