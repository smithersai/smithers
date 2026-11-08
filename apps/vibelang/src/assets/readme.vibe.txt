error UserNotFound { id: string }
service Users {
  find(id: string): string!UserNotFound
}

const UsersLive = Layer.succeed(Users, {
  effect find(id: string) {
    if (id !== "42") throw new UserNotFound({ id })
    return "Ada"
  }
})

export effect function main() {
  provide UsersLive {
    const users = try Users
    const [name, fallback] = try.all [
      users.find("42"),
      effect { return users.find("7") catch () => "Guest" }
    ]
    try Console.log(name, fallback)
  }
}

runPromise(main())
