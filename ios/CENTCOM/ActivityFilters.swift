import Foundation

struct ActivityFilters {
    var actor = ""
    var kind = ""
    var oldestFirst = false
    var isActive: Bool { !actor.isEmpty || !kind.isEmpty }

    func apply(to events: [ActivityEvent]) -> [ActivityEvent] {
        events.filter {
            (actor.isEmpty || $0.agent == actor) && (kind.isEmpty || $0.type == kind)
        }.sorted {
            if $0.ts == $1.ts { return $0.id < $1.id }
            return oldestFirst ? $0.ts < $1.ts : $0.ts > $1.ts
        }
    }

    static func label(for kind: String) -> String {
        switch kind {
        case "ticket.created": "Task created"
        case "ticket.updated": "Task updated"
        case "ticket.comment": "Comment"
        case "agent.instructions_changed": "Instructions changed"
        default: kind.replacingOccurrences(of: ".", with: " ").capitalized
        }
    }
}
