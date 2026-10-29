# Credential Import

## Why this exists

The old Bitget importer piped JSON into `npm run executor:secrets`. With npm 11
on Windows PowerShell, `--merge` was consumed as an npm config flag instead of
being forwarded to the CLI. The CLI therefore replaced the whole secret store
instead of merging. That is how the Gate/Hotcoin records were lost.

The importer now calls `tsx` directly, and the CLI refuses to overwrite an
existing store unless `--replace` is explicitly supplied.

## Safe multi-venue import

1. Copy the template:

   ```powershell
   Copy-Item config/api-keys.example.json data/api-keys.json
   ```

2. Fill only the records you have. `data/` is ignored by Git. Example for Gate
   and Bitget:

   ```json
   [
     {
       "venueId": "gateio",
       "role": "trade",
       "withdrawalPermission": false,
       "apiKey": "GATE_API_KEY",
       "secret": "GATE_SECRET"
     },
     {
       "venueId": "bitget",
       "role": "trade",
       "withdrawalPermission": false,
       "apiKey": "BITGET_API_KEY",
       "secret": "BITGET_SECRET",
       "password": "BITGET_API_PASSPHRASE"
     }
   ]
   ```

   `password` is Bitget's API passphrase. For a withdrawal record, set
   `"role": "withdrawal"`, `"withdrawalPermission": true`, and
   `"ipWhitelistVerified": true` only after the exchange IP whitelist is
   verified.

3. Import with merge and delete the local file after success:

   ```powershell
   npm run executor:secrets:import -- -CredentialFile data/api-keys.json -DeleteCredentialFile
   ```

   The command prints only `venueId:role` fingerprints. It never prints keys,
   secrets, or passphrases. Existing records are preserved.

4. If you intentionally want to reset the entire store, use the CLI directly:

   ```powershell
   npm run executor:secrets -- --replace
   ```

   Do not use `--replace` for a normal credential update.

## Bitget-only import

The convenience command still works and always merges:

```powershell
npm run executor:secrets:bitget -- -CredentialFile data/bitget-credential.local.json -DeleteCredentialFile
```

The file must contain one JSON object with `apiKey`, `secret`, and `password`
(or `passphrase`). If no file is supplied, the script reads
`data/bitget-credential.local.json` when it exists; otherwise it prompts in an
interactive terminal.

## Recovery note

The Gate/Hotcoin records overwritten by the old importer cannot be recovered
from the current encrypted store. Re-enter the Gate key through the multi-venue
import above. Bitget's existing record is preserved by merge.
