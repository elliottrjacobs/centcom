import XCTest
@testable import CENTCOM
final class TaskFilteringTests: XCTestCase {
    private func ticket(_ id: String = "CEN-1", priority: Int = 0, due: String? = nil, status: TaskStatus = .todo) -> Ticket {
        Ticket(id: id, title: id, status: status, priority: priority, due: due, labels: ["Bug", "iOS"], body: "", updated: 1)
    }
    func testCombinedFiltersAndOverdueExcludesClosedTasks() {
        var filter = TaskFilters(); filter.labels = ["bug", "ios"]; filter.priority = "0"; filter.assignee = "__none"; filter.project = "__inbox"; filter.due = "overdue"
        XCTAssertTrue(filter.matches(ticket(due: "2026-09-21"), today: "2026-09-22"))
        XCTAssertFalse(filter.matches(ticket(due: "2026-09-22"), today: "2026-09-22"))
        XCTAssertFalse(filter.matches(ticket(due: "2026-09-21", status: .done), today: "2026-09-22"))
        XCTAssertFalse(filter.matches(ticket(), today: "2026-09-22"))
        filter.labels.append("Missing"); XCTAssertFalse(filter.matches(ticket(due: "2026-09-21"), today: "2026-09-22"))
    }
    func testSortPlacesMissingValuesLast() {
        let tasks = [ticket("CEN-3"), ticket("CEN-2", priority: 1, due: "2026-09-23"), ticket(priority: 3, due: "2026-09-22")]
        XCTAssertEqual(tasks.sorted(by: TaskSort.priority.precedes).map(\.id), ["CEN-2","CEN-1","CEN-3"])
        XCTAssertEqual(tasks.sorted(by: TaskSort.due.precedes).map(\.id), ["CEN-1","CEN-2","CEN-3"])
    }
    func testTabsAndChronologicalSortAcrossEveryStatus() {
        let statuses: [TaskStatus] = [.inProgress, .inReview, .todo, .backlog, .done, .canceled]
        let tickets = statuses.enumerated().map { index, status in
            var task = ticket("CEN-\(index + 1)", status: status)
            task.created = Double(index + 1)
            task.updated = Double(6 - index)
            return task
        }
        XCTAssertEqual(TaskScope.all.tasks(from: tickets, sort: .created).map(\.id), ["CEN-6", "CEN-5", "CEN-4", "CEN-3", "CEN-2", "CEN-1"])
        XCTAssertEqual(TaskScope.open.tasks(from: tickets, sort: .created).map(\.id), ["CEN-4", "CEN-3", "CEN-2", "CEN-1"])
        XCTAssertEqual(TaskScope.done.tasks(from: tickets, sort: .created).map(\.id), ["CEN-5"])
        XCTAssertEqual(TaskScope.all.tasks(from: tickets, sort: .updated).map(\.id), ["CEN-1", "CEN-2", "CEN-3", "CEN-4", "CEN-5", "CEN-6"])
    }
    func testRecentlyCreatedIsIndependentOfRecentUpdates() {
        var older = ticket("CEN-1", status: .inProgress)
        older.created = 100; older.updated = 500
        var newer = ticket("CEN-2", status: .backlog)
        newer.created = 200; newer.updated = 200
        XCTAssertEqual(TaskScope.open.tasks(from: [older, newer], sort: .created).first?.id, newer.id)
        XCTAssertEqual(TaskScope.open.tasks(from: [older, newer], sort: .updated).first?.id, older.id)
    }
    func testRenameKeepsDraftLabelSelectionWithoutDuplicates() {
        XCTAssertEqual(replacingLabel("bug", with: "Defect", in: ["Bug", "iOS"]), ["Defect", "iOS"])
        XCTAssertEqual(replacingLabel("Bug", with: "Defect", in: ["Bug", "Defect"]), ["Defect"])
        XCTAssertEqual(replacingLabel("Bug", with: "Defect", in: ["iOS"]), ["iOS"])
    }
    func testReusableLabelsPreserveDisplayName() {
        XCTAssertEqual(uniqueLabels([" Release   Blocker ", "release blocker", "Bug", "bug", ""]), ["Release Blocker", "Bug"])
        XCTAssertEqual(labelHue("Bug"), labelHue("bug"))
    }
}
