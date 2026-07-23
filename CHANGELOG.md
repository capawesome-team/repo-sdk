# Changelog

## [0.1.4](https://github.com/capawesome-team/repo-sdk/compare/v0.1.3...v0.1.4) (2026-07-23)


### Bug Fixes

* **bitbucket:** adapt to CHANGE-2770 removal of cross-workspace APIs ([d5b3b6e](https://github.com/capawesome-team/repo-sdk/commit/d5b3b6ec236efa723317d8a62de719e4bb6cdadf))

## [0.1.3](https://github.com/capawesome-team/repo-sdk/compare/v0.1.2...v0.1.3) (2026-07-23)


### Features

* add listUserInstallations to the github subpath ([b2cf80d](https://github.com/capawesome-team/repo-sdk/commit/b2cf80dc7197579c50c9a103181f55887c2fe6c8))


### Bug Fixes

* **github:** call fetch detached to avoid Illegal invocation on workerd ([b495fdc](https://github.com/capawesome-team/repo-sdk/commit/b495fdce8633fff6d6852e7bdbd85785894e2ebe))
* **http:** send default repo-sdk User-Agent on all requests ([ed126d0](https://github.com/capawesome-team/repo-sdk/commit/ed126d01144ba5ac5391bebaa33eddef3f629f5f))

## [0.1.2](https://github.com/capawesome-team/repo-sdk/compare/v0.1.1...v0.1.2) (2026-07-20)


### Features

* accept fully-qualified refs in refs.resolve, add RefMatch.ref, resolve full SHAs commit-first ([205f0b8](https://github.com/capawesome-team/repo-sdk/commit/205f0b8924a5c7e7d2e02fa3b48afb82e13f6c3b))

## [0.1.1](https://github.com/capawesome-team/repo-sdk/compare/v0.1.0...v0.1.1) (2026-07-20)


### Features

* add git-http provider for generic smart-HTTP remotes ([0aca86d](https://github.com/capawesome-team/repo-sdk/commit/0aca86d904c8dbc00b12c20b1652a965a60877b1))
* add refs.resolve, branches.get, and tags.get ([958b4b2](https://github.com/capawesome-team/repo-sdk/commit/958b4b28227057fca6d9244e62a9d9714062ec4d))

## 0.1.0 (2026-07-19)


### Features

* add branch listing and ref search ([c337f25](https://github.com/capawesome-team/repo-sdk/commit/c337f25c7594507c10f98af419c9fb1bf45fe2da))
* add commit author user refs and namespace avatars ([9c10ff5](https://github.com/capawesome-team/repo-sdk/commit/9c10ff5d6a69329d41d1aa3a6a1c2b656e72ad02))
* add Gitea provider ([d40ceb6](https://github.com/capawesome-team/repo-sdk/commit/d40ceb6e52de99d4ac4ca29600c9cd0df28df062))
* add users.me() for the authenticated user profile ([e15bd4b](https://github.com/capawesome-team/repo-sdk/commit/e15bd4b653a045c8b1cfa156b0deefb2e7c55503))
* expand webhook parsing, Azure DevOps auth, and commit URL helpers ([0cf6fba](https://github.com/capawesome-team/repo-sdk/commit/0cf6fba5683e0297351a9ab5fb0fc181b46c3b56))
* **github:** expose installation tokens via getInstallationToken ([54938a7](https://github.com/capawesome-team/repo-sdk/commit/54938a75b2eb3deb13ed8b1f67da64de3700dd36))
* **github:** resolve app installation by owner ([4b3f971](https://github.com/capawesome-team/repo-sdk/commit/4b3f9716bd69c5f48cd077fe66921754072b3902))
* guarantee Repository.urls.web is always present ([ed6aadb](https://github.com/capawesome-team/repo-sdk/commit/ed6aadb4e77ad7bd42ddf5aa9274c29a2f89ec30))
* initial repo-sdk implementation ([ee2b6dd](https://github.com/capawesome-team/repo-sdk/commit/ee2b6dd00523131cd297969ca1caa7ed84b8e18c))
* resolve hidden account emails via users.me includeEmail ([1404c06](https://github.com/capawesome-team/repo-sdk/commit/1404c06e8cbca8f5e3b0e63c1167d2c7b64fbf4d))
* support async token providers for all providers ([e025a42](https://github.com/capawesome-team/repo-sdk/commit/e025a428b1609b4ccdf720b22a4a9eac5a954474))
* **testing:** allow configuring provider name and capabilities ([e43ddf3](https://github.com/capawesome-team/repo-sdk/commit/e43ddf3a8353dd44248b3fc57d8baf30fc624bef))
* **webhooks:** add detectWebhookProvider helper ([19668b6](https://github.com/capawesome-team/repo-sdk/commit/19668b6f31483cc4dd6618baaf960dedd8f0a0aa))


### Bug Fixes

* **build:** add unrun devDependency so tsdown loads its config on Node 20 ([9a58902](https://github.com/capawesome-team/repo-sdk/commit/9a58902f23b04d8de3b9909009da9108ea9438c7))
* **docs:** correct footer spacing and rework attribution line ([28d5099](https://github.com/capawesome-team/repo-sdk/commit/28d5099893fb624ed6340f97e71dfa10863fcd38))
* **docs:** repair MDX comment mangled by prettier and ignore mdx files ([2213258](https://github.com/capawesome-team/repo-sdk/commit/2213258c141cc024581f33f290d6a969aba1fdee))
* **docs:** restore readable accent foreground in dark mode ([063c53c](https://github.com/capawesome-team/repo-sdk/commit/063c53c9741a88ab7de6c6040388ce7a6693d946))
* type-check custom pages against Blume's Astro config ([fdf1f7b](https://github.com/capawesome-team/repo-sdk/commit/fdf1f7b20dadcb5fdcb91bf3c0fc9c1bd493deb0))
