variable "project_name" {
  type = string
}

variable "environment" {
  type = string
}

variable "tags" {
  type    = map(string)
  default = {}
}

# Origins permitted to upload to, and fetch from, the plugin media bucket.
#
# The browser PUTs bytes directly to S3 rather than through a Lambda, so S3
# itself must allow the platform's own origin. Empty by default: a bucket that
# accepts uploads from anywhere is a worse default than one that accepts none,
# and the failure is loud (a CORS error in the console) rather than silent.
variable "plugin_media_cors_origins" {
  description = "Origins allowed to upload to / fetch from the plugin media bucket, e.g. [\"https://dev.example.com\"]. Empty allows none."
  type        = list(string)
  default     = []
}
