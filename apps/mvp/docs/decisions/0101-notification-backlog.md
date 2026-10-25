# 0101: Notification backlog stays in the bell

2026-10-25. Implements AUTH-4 and Will's notification bug bash.

Decision 0036's live toasts still reserve document space, with at most three cards. Overflow never renders above page content: remaining and older entries are reachable through the bell. Model spend is never a toast. Admins see unseen spend alerts in the bell count and panel, alongside the existing configured email and Telegram delivery. Hide retains the existing device watermark semantics. This changes presentation only; channel sends remain durable steps through `@smthrs/notifications`.
