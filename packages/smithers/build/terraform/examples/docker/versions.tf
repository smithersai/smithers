terraform {
  required_version = ">= 1.9.0"

  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "3.9.0"
    }
  }
}

provider "docker" {
  # The default socket on Linux and on Docker Desktop for macOS. Run Terraform
  # on the daemon's machine: the module bind-mounts its local migrations directory.
  host = "unix:///var/run/docker.sock"
}
