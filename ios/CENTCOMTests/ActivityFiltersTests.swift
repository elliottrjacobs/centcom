import XCTest
@testable import CENTCOM

final class ActivityFiltersTests: XCTestCase {
    func testEventAuthorAndKindCombineIndependentlyOfCurrentTaskData() {
        let events = fixtures()
        var filters = ActivityFilters(actor: "codex", kind: "ticket.comment")
        XCTAssertEqual(filters.apply(to: events).map(\.id), ["c"])
        filters.actor = "legacy-agent"
        XCTAssertEqual(filters.apply(to: events).map(\.id), ["a"])
        filters.kind = "ticket.updated"
        XCTAssertTrue(filters.apply(to: events).isEmpty)
    }

    func testChronologyAndReset() {
        let events = fixtures()
        var filters = ActivityFilters()
        XCTAssertEqual(filters.apply(to: events).map(\.id), ["b", "c", "a"])
        filters.oldestFirst = true
        XCTAssertFalse(filters.isActive)
        XCTAssertEqual(filters.apply(to: events).map(\.id), ["a", "c", "b"])
        filters.actor = "codex"
        filters = ActivityFilters()
        XCTAssertEqual(filters.apply(to: events).count, 3)
        XCTAssertFalse(filters.oldestFirst)
    }

    private func fixtures() -> [ActivityEvent] {
        [ActivityEvent(id: "a", ts: 10, agent: "legacy-agent", type: "ticket.comment", ticket: "CEN-1", subject: nil, body: nil),
         ActivityEvent(id: "b", ts: 30, agent: "codex", type: "ticket.updated", ticket: "CEN-1", subject: nil, body: nil),
         ActivityEvent(id: "c", ts: 20, agent: "codex", type: "ticket.comment", ticket: "CEN-2", subject: nil, body: nil)]
    }
}
