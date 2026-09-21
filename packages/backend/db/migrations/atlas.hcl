env "local" {
  url = getenv("SMITHERS_ATLAS_URL")
  dev = getenv("SMITHERS_ATLAS_DEV_URL")

  migration {
    dir = "file://db/migrations"
  }
}

env "ci" {
  url = getenv("SMITHERS_ATLAS_URL")
  dev = getenv("SMITHERS_ATLAS_DEV_URL")

  migration {
    dir = "file://db/migrations"
  }
}
