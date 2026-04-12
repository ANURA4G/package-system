# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- Bucket metadata edit flow (display name, region, size limit, KMS, notes).
- Typed confirmation phrase for bucket configuration deletion.
- Advanced bucket options in UI for KMS and notes.
- Pending/manual validation persistence for bucket add in specific AWS rejection cases.

### Changed

- Upload bucket handling now enforces explicit bucket selection in upload actions.
- Resume behavior now validates bucket context more strictly.
- Multipart route flow aligned to resolve bucket credentials from stored bucket records.
- Auth token browser persistence changed from local storage to session storage.

### Security

- Reduced reliance on global AWS fallback values for multipart flow.
- Improved bucket-session consistency checks across upload lifecycle APIs.

### UX

- Upload target default label changed to None.
- Clearer status messaging for non-verified bucket validation states.
