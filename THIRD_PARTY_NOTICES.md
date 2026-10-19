# Third-Party Notices

## Gogma Artian Roll Planner

- Project: Gogma Artian Roll Planner
- Creator: WiseHorror
- Reference version: 0.9.4
- Nexus Mods: <https://www.nexusmods.com/monsterhunterwilds/mods/4705>
- GitHub: <https://github.com/WiseHorror/Gogma-Artian-Roll-Planner>
- Reference commit: `eceb2bd9ca6f4897ec516387acab2ad6beb8b38b`
- Reference file: `reframework/autorun/GARP.lua`
- Reference file SHA-256: `dd9ff4ede166542c1efa4bc13595b2d064c581676c289893946af2f9b5551282`
- Reference archive SHA-256: `24c799cd96af0356b010c97eba4aa190486e2896454cbb5a922ba94dc988e5fa`

GogmaArtianPlanner uses the pinned GARP.lua v0.9.4 as an external Reference
Implementation for compatible Artian and Gogma Artian RNG behavior. The
project's TypeScript implementation includes reference-verified constants,
tables, ordering, and behavior. GogmaArtianPlanner independently implements
its Domain structures, validation, Seed and Counter Identification, Candidate
Search, Build List, Planner, and related product behavior.

The upstream GARP.lua file, Nexus archive, and GARP assets are not vendored in
this repository. This project is not affiliated with, approved by, or endorsed
by WiseHorror.

According to the permissions published by the creator on Nexus Mods, the
creator permits activities including redistribution, modification,
improvements, conversion, and asset use under the conditions stated there,
including creator-credit conditions. The published permissions also state
that mods using the creator's assets may not earn Donation Points. This
repository does not vendor GARP assets. The Nexus Mods page is the
authoritative source for the creator's current permissions and conditions;
these permissions are not represented here as a standard open-source license.

## Bundled Open-Source Dependencies

Production builds include open-source dependencies. The complete generated
license inventory is included in the distribution as `licenses.md`.

### Dexie.js NOTICE

The following notice is reproduced verbatim from the `NOTICE` file distributed
with Dexie.js 4.4.5:

```text
Dexie.js

Copyright (c) 2014-2017 David Fahlander

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```
