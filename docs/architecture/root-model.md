# P1 Root Model

The framework keeps five roots separate:

| Root | Purpose | Durability | Candidate-controlled |
| --- | --- | --- | --- |
| Framework | Versioned framework source and public policy | Durable | Yes |
| Workspace | User-selected project data | Durable by user choice | No |
| Transient | Caches and disposable computation | Disposable | No |
| Evidence locator | References to proof stored outside framework source | Durable locator only | No |
| Release trust | Public keys and constraints used to admit a release | Durable external authority | Never |

The framework root must not silently discover or import another root. Workspace,
transient, evidence-locator, and release-trust paths are explicit inputs. A path
may represent only one root in an operation.

Development mode can operate on framework and explicitly selected workspace or
transient roots. Release mode additionally requires an external release-trust
root and a verified bundle. Evidence locators are references; they are not a
license to embed private evidence in source or release archives.
