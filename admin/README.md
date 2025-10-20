# Admin Scripts

This directory contains administrative scripts for managing the CloudProjectMarker stack.

## API Key Management

### `list_api_keys.sh`
Lists all API keys currently registered in the usage plan with their actual key values.

**Usage:**
```bash
# Display CSV to stdout
./list_api_keys.sh

# Save CSV to file
./list_api_keys.sh api_keys.csv
```

**Output:**
- Displays CSV format showing all API keys with their names (emails), IDs, and actual key values
- Shows the total count of API keys
- Can save directly to a CSV file for Excel/spreadsheet import

**Example (stdout):**
```
=== List All API Keys in Usage Plan ===

Usage Plan Name: grader-usage-plan
Usage Plan ID: abc123

Found 2 API key(s):

Name,API Key ID,API Key Value
"student1@example.com","a1b2c3d4e5","xYzAbC123DefGhI456..."
"student2@example.com","f6g7h8i9j0","JklMnO789PqrStU012..."

Total: 2 API key(s)
```

**Example (save to file):**
```bash
./list_api_keys.sh student_keys.csv
# Output: CSV output saved to: student_keys.csv
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

**Example:**
```
=== Delete All API Keys from Usage Plan ===

Usage Plan Name: grader-usage-plan
Usage Plan ID: abc123

Found 5 API key(s) to delete.

Are you sure you want to delete all 5 API key(s)? (yes/no): yes

Starting deletion process...

Processing: student1@example.com (ID: a1b2c3d4e5)
  → Removing from usage plan...
  ✓ Removed from usage plan
  → Deleting API key...
  ✓ API key deleted successfully

...

=== Summary ===
Successfully deleted: 5 API key(s)

Done!
```

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

### Reset all API keys for a new semester
```bash
# First, check current API keys
./list_api_keys.sh

# Delete all existing API keys
./delete_all_api_keys.sh

# Verify deletion
./list_api_keys.sh
```

### Debug API key issues
```bash
# List current API keys to verify they exist
./list_api_keys.sh

# Check if a specific student's API key is registered
./list_api_keys.sh | grep "student@example.com"
```

## Important Notes

⚠️ **WARNING:** These scripts perform destructive operations. Always:
1. Verify you're working with the correct stack/environment
2. Read the confirmation prompts carefully
3. Have backups if necessary
4. Test in a non-production environment first

## Stack Configuration

The scripts are configured for:
- **Stack Name:** `CloudProjectMarker`
- **Region:** `us-east-1`

To use with a different stack or region, edit the variables at the top of each script:
```bash
STACK_NAME="YourStackName"
REGION="your-region"
```
