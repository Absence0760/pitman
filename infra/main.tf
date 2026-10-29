terraform {
  # use_lockfile (S3-native state locking) needs 1.10+; tfenv reads the exact
  # version from infra/.terraform-version.
  required_version = ">= 1.11, < 2.0"

  # Partial backend config: the bucket name embeds the account ID and the
  # bucket lives in whichever region the estate bootstrap was run with, so
  # both come from infra/backend.config (gitignored; copy
  # backend.config.example) at `terraform init -backend-config=backend.config`.
  # Locking uses S3 conditional writes; no DynamoDB table.
  backend "s3" {
    key          = "prod/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.70"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}

# Primary region (D-6: af-south-1, beside IC-WBT's buckets): the API Lambda,
# the site bucket, the alarms on them and the main SNS topic. af-south-1 is an
# opt-in region: it must be enabled in the account before the first plan
# (docs/deployment.md § First deploy).
provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.tags
  }
}

# CloudFront's ACM certificate, its WAF web ACL and its CloudWatch metrics all
# live in us-east-1, whatever the primary region is.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = local.tags
  }
}

data "aws_caller_identity" "current" {}

locals {
  project    = "pitman"
  account_id = data.aws_caller_identity.current.account_id

  tags = {
    Project     = "pitman"
    ManagedBy   = "terraform"
    Environment = "production"
    Repository  = var.github_repo
  }
}
