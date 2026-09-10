/* The notifications card: the list plus one mark-all-read act. */
import { Badge, Button } from "@smthrs/ui"
import { Bell, BellDot } from "lucide-react"
import type { Card } from "../state/AppState"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"

export const NotificationsCardBody = ({
  card,
  onRunCommand
}: {
  readonly card: Extract<Card, { kind: "notifications" }>
  readonly onRunCommand: RunCommand
}) => (
  <div className="world-card-list">
    <ul className="world-card-list">
      {card.payload.items.length === 0 ?
        (
          <li className="world-card-empty">
            Nothing new. Notifications follow the repositories you have loaded.
          </li>
        ) :
        (
          card.payload.items.map((item) => (
            <li key={item.id} className="world-card-row" data-read={item.read}>
              <span className="connect-store-icon">
                {item.read ? <Bell size={14} /> : <BellDot size={14} />}
              </span>
              <span className="world-card-title">{item.title}</span>
              {item.repo !== null ? <span className="world-card-path">{item.repo}</span> : null}
              {item.reason !== null ? <span className="world-card-path">{item.reason}</span> : null}
              {item.read ? null : <Badge variant="outline">unread</Badge>}
            </li>
          ))
        )}
    </ul>
    {card.payload.unread > 0 ?
      (
        <Button
          size="sm"
          variant="outline"
          data-flow="notifications.read"
          onClick={() => onRunCommand("notifications.read")}
        >
          Mark all read
        </Button>
      ) :
      null}
  </div>
)

export const notificationsCardFamily: CardFamily<"notifications"> = {
  notifications: {
    render: (card, actions) => <NotificationsCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  }
}
