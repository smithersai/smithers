/** A real faulty HTTP child: consume requests and stall headers or body. */
import { createServer } from "node:http"
const mode = process.argv[2]
let requests = 0
const server = createServer((request, response) => {
  request.resume()
  process.send({ request: ++requests })
  if (mode === "exit") process.exit(17)
  if (mode === "headers") return
  response.writeHead(mode === "retry" && requests === 1 ? 404 : 200)
  if (mode === "body") {
    response.flushHeaders()
    response.write("incomplete")
  } else response.end("\n")
})
server.listen(0, "127.0.0.1", () => process.send({ port: server.address().port }))
