variable "environment_name" {
  description = "Name of the azd environment (e.g. dev, prod)"
  type        = string
}

variable "location" {
  description = "Azure region for all resources"
  type        = string
  default     = "uksouth"
}