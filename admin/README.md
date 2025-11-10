# Admin Scripts

This directory contains administrative scripts for managing the CloudProjectMarker stack.

## API Key Management

### `list_api_keys.sh`
Lists all API keys currently registered in the usage plan with their actual key values.

**Usage:**
```bash
# Save to timestamped CSV file (default)
./list_api_keys.sh

# Save to specific CSV file
./list_api_keys.sh api_keys.csv
```

**Output:**
- Generates CSV format showing all API keys with their names (emails), IDs, and actual key values
- Shows the total count of API keys
- Saves to CSV file for Excel/spreadsheet import

**Example:**
```bash
./list_api_keys.sh student_keys.csv
# Output: ✓ CSV output saved to: student_keys.csv
```

---

### `generate_api_key.sh`
Generates a single API key for an email address. Replicates the Lambda KeyGenFunction logic.

**Usage:**
```bash
# Generate key for one email
./generate_api_key.sh student@vtc.edu.hk

# Force regenerate if already exists
./generate_api_key.sh student@vtc.edu.hk --force
```

**Features:**
- Checks if key already exists for the email
- Creates API key in API Gateway
- Associates key with usage plan
- Stores mapping in DynamoDB lookup table
- Atomic operation with automatic rollback on failure
- Returns the generated API key value

**Example:**
```
=== Generate API Key ===
Email: student@vtc.edu.hk

Creating API key...
✓ Created API key
Key ID: abc123xyz
Key Value: xYzAbC123DefGhI456...

✓ Associated with usage plan
✓ Stored in DynamoDB

=== Success ===
API Key generated for: student@vtc.edu.hk
Key Value: xYzAbC123DefGhI456...
```

---

### `batch_generate_keys.sh`
Batch generates API keys for all emails listed in `email.txt`.

**Usage:**
```bash
# Generate keys for all emails (sequential, safer)
./batch_generate_keys.sh

# Generate in parallel (faster)
./batch_generate_keys.sh --parallel

# Force regenerate all keys
./batch_generate_keys.sh --force --parallel
```

**Features:**
- Processes all emails from `email.txt`
- Sequential or parallel processing modes
- Skips emails that already have keys (unless --force)
- Shows progress for each email
- Provides detailed summary

**Example:**
```
=== Batch Generate API Keys ===

Found 101 email(s) in email.txt
Mode: Parallel (faster)

Continue? (y/n) y

Processing emails...

Processing: student1@vtc.edu.hk
  ✓ Generated
Processing: student2@vtc.edu.hk
  ✓ Already exists
...

=== Summary ===
Total emails: 101
Generated: 95
Skipped (already exist): 6
Errors: 0

✅ Batch generation complete!
```

---

### `validate_api_keys.sh`
Validates consistency between API Gateway, DynamoDB, and the source email list.

**Usage:**
```bash
./validate_api_keys.sh
```

**Features:**
- Compares API Gateway keys, DynamoDB entries, and `email.txt` (source of truth)
- Identifies 7 types of issues:
  1. Emails missing from API Gateway
  2. Emails missing from DynamoDB
  3. Unauthorized emails in API Gateway
  4. Orphaned emails in DynamoDB
  5. Keys in API Gateway but not DynamoDB
  6. Keys in DynamoDB but not API Gateway
  7. Email mismatches for the same key
- Provides detailed report with counts

**Example:**
```
=== Validate API Keys Consistency ===

Source emails (email.txt): 101
API Gateway keys: 101
DynamoDB entries: 101

=== Validation Results ===

1. Checking emails in email.txt but missing from API Gateway...
✓ All emails from email.txt have keys in API Gateway

2. Checking emails in email.txt but missing from DynamoDB...
✓ All emails from email.txt have entries in DynamoDB

...

=== Summary ===
Issues found:
  - Emails missing from API Gateway: 0
  - Emails missing from DynamoDB: 0
  - Unauthorized emails in API Gateway: 0
  - Orphaned emails in DynamoDB: 6
  - Keys in API Gateway but not DynamoDB: 0
  - Keys in DynamoDB but not API Gateway: 6
  - Email mismatches: 0

❌ Validation failed! Found 12 issue(s).
```

---

### `sync_api_keys.sh`
Synchronizes API keys between API Gateway and DynamoDB to fix inconsistencies.

**Usage:**
```bash
# Preview changes without applying them
./sync_api_keys.sh --dry-run

# Apply the sync
./sync_api_keys.sh
```

**Features:**
- Adds missing DynamoDB entries for API Gateway keys
- Removes orphaned DynamoDB entries for deleted API Gateway keys
- Dry-run mode to preview changes
- Atomic operations with error handling

**Example:**
```
=== Sync API Keys between API Gateway and DynamoDB ===

=== Step 1: Adding missing DynamoDB entries ===
✓ No missing entries to add

=== Step 2: Removing orphaned DynamoDB entries ===
Orphaned in DynamoDB:
  Email: 240106071@stu.vtc.edu.hk
  Key: 85wQc1tar+PxnctOIs1C1Et06u8JCbysEU1hLOF0JZI=
  ✓ Deleted from DynamoDB
...

=== Summary ===
Added to DynamoDB: 0
Deleted from DynamoDB: 6

✅ Sync complete! Run ./validate_api_keys.sh to verify.
```

---

### `delete_all_api_keys.sh`
Deletes all API keys from the usage plan and removes the keys themselves.

**Usage:**
```bash
./delete_all_api_keys.sh
```

**Features:**
- Lists all API keys that will be deleted
- Requires confirmation before proceeding
- Removes keys from usage plan first
- Deletes the actual API keys
- Shows progress for each key
- Provides a summary of successful and failed deletions

**Safety:**
- Includes a confirmation prompt: type `yes` to proceed
- Can be aborted by typing anything other than `yes`

---

## DynamoDB Management

### `delete_all_passed_test_items.sh`
Deletes all records from the PassedTestTable.

**Note:** Update the `table_name` variable in the script to match your actual table name.

---

### `delete_all_failed_test_items.sh`
Deletes all records from the FailedTestTable.

**Note:** Update the `table_name` variable in the script to match your actual table name.

---

### `export_marks.sh`
Exports student marks/scores from the DynamoDB tables.

---

### `test_account.sh`
Tests AWS account configuration.

---

## Prerequisites

All scripts require:
- AWS CLI installed and configured
- Appropriate AWS permissions for API Gateway and DynamoDB operations
- `jq` command-line JSON processor installed
- Bash shell

## Common Use Cases

### Setup API keys for a new semester
```bash
# 1. Add student emails to email.txt (one per line)
vim email.txt

# 2. Generate keys for all students
./batch_generate_keys.sh --parallel

# 3. Verify all keys were created
./validate_api_keys.sh

# 4. Export keys to CSV for distribution
./list_api_keys.sh student_keys_2024.csv
```

---

### Fix inconsistent API key data
```bash
# 1. Check for inconsistencies
./validate_api_keys.sh

# 2. Preview the sync changes
./sync_api_keys.sh --dry-run

# 3. Apply the sync
./sync_api_keys.sh

# 4. Verify consistency
./validate_api_keys.sh
```

---

### Reset all API keys for a new semester
```bash
# 1. Check current API keys
./list_api_keys.sh

# 2. Delete all existing API keys
./delete_all_api_keys.sh

# 3. Verify deletion
./list_api_keys.sh

# 4. Generate new keys
./batch_generate_keys.sh --parallel
```

---

### Debug API key issues
```bash
# List current API keys to verify they exist
./list_api_keys.sh

# Check if a specific student's API key is registered
./list_api_keys.sh student_keys.csv
grep "student@example.com" student_keys.csv

# Validate consistency
./validate_api_keys.sh

# Generate key for a single student
./generate_api_key.sh student@example.com
```

---

## Important Notes

⚠️ **WARNING:** These scripts perform destructive operations. Always:
1. Verify you're working with the correct stack/environment
2. Read the confirmation prompts carefully
3. Have backups if necessary
4. Test in a non-production environment first

## Configuration

The scripts use a centralized configuration file `config.sh` which defines:
- **Stack Name:** `CloudProjectMarker`
- **Region:** `us-east-1`

To use with a different stack or region, edit `config.sh`:
```bash
STACK_NAME="YourStackName"
AWS_REGION="your-region"
```

## Workflow Recommendations

**For maintaining data consistency:**
1. Always use `validate_api_keys.sh` to check for issues
2. Use `sync_api_keys.sh` to fix inconsistencies automatically
3. Deploy the updated `KeyGenFunction.cs` to prevent future inconsistencies

**For key generation:**
- Use `batch_generate_keys.sh --parallel` for bulk operations (faster)
- Use `generate_api_key.sh` for individual student keys
- Always run `validate_api_keys.sh` after bulk operations

**Source of truth:**
- `email.txt` contains the authoritative list of student emails
- All validation checks against this file
- Keep this file updated with current student roster
