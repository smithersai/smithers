# Hosted walkthroughs

`POST /api/walkthroughs` reserves metadata before uploading HTML. Each session
can hold up to 50 walkthroughs, including pending uploads. Concurrent requests
for the last slot yield one success and a `429` for the other request.

`GET /api/walkthroughs?repo=owner/name` includes `status` on each history entry:
`pending` during upload or after interruption, and `complete` after upload and
metadata finalization. Existing walkthroughs migrate to `complete`.

Upload or finalization failures remove the object before releasing the slot.
If object cleanup fails or the worker stops, the pending metadata remains.
Use the authorized `DELETE /api/walkthroughs/:id` endpoint to remove pending
entries and their objects, then retry publishing. Pending entries use the same
repository authorization as complete entries. If deletion wins while an upload
is in flight, publishing cleans up the late object and returns `409`.

Hosted URLs are unlisted, not authenticated: anyone with the URL can read the
HTML, including private-repository diffs. Responses use `Cache-Control: no-store`;
deletion removes the hosted copy but cannot recall files already downloaded.
