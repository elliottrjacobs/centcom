import XCTest
@testable import CENTCOM
final class SkillsTests: XCTestCase {
    func testNavigationRestoresOrderAndAppendsNewPages() {
        let pages = AppPage.ordered("skills,skills,removed,inbox")
        XCTAssertEqual(Array(pages.prefix(2)), [.skills, .inbox])
        XCTAssertEqual(Set(pages), Set(AppPage.allCases))
        XCTAssertEqual(pages.count, AppPage.allCases.count)
    }
    func testPinnedPagesRespectOrderAndSkipHiddenPages() {
        let pages = AppPage.visible("skills,projects,inbox,tasks", hidden: "projects")
        XCTAssertEqual(Array(pages.prefix(3)), [.skills, .inbox, .tasks])
        XCTAssertEqual(Array(pages.dropFirst(3)), [.activity, .agents, .instructions, .settings])
        XCTAssertEqual(AppPage.visible("skills", hidden: AppPage.allCases.map(\.rawValue).joined(separator: ",")), [])
    }
    func testDefaultPageRestoresSavedChoiceAndHandlesUnknownValues() {
        XCTAssertEqual(AppPage.opening("instructions"), .instructions)
        XCTAssertEqual(AppPage.opening("projects"), .projects)
        XCTAssertEqual(AppPage.opening(nil), .tasks)
        XCTAssertEqual(AppPage.opening("removed"), .tasks)
    }
    func testInventoryDecodesOptionalProjectAndSource() throws {
        let data = Data(#"{"skills":[{"id":"one","name":"Example","description":"Example Skill","sourceUrl":null,"versions":1,"installations":[{"id":"copy","deviceId":"mini","deviceName":"Mac mini","agent":"Grok","scope":"global","project":null,"path":"/skills/example/SKILL.md","hash":"abc","reportedAt":1700000000000}]}],"devices":[{"id":"mini","name":"Mac mini","reportedAt":1700000000000}]}"#.utf8)
        let catalog = try JSONDecoder().decode(SkillCatalog.self, from: data)
        XCTAssertEqual(catalog.skills[0].installations[0].label, "Mac mini · Grok · Global")
        XCTAssertNil(catalog.skills[0].sourceUrl)
    }
}
