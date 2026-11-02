import XCTest

/// Run against a local development server; these flows only read inventory data and change simulator preferences.
final class NavigationUITests: XCTestCase {
    @MainActor func testActivityAndSkillsFilterControls() throws {
        let server = try XCTUnwrap(ProcessInfo.processInfo.environment["CENTCOM_UI_TEST_SERVER"])
        let app = XCUIApplication()
        app.launchArguments = ["-serverAddress", server, "-navigation.startPage", "activity", "-navigation.order.v1", "tasks,inbox,projects,activity,agents,skills,instructions,settings", "-navigation.hidden.v1", ""]
        app.launch()
        XCTAssertTrue(app.buttons["Filter activity"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.navigationBars.buttons["Settings"].exists)
        capture(app, "activity-default")
        app.buttons["Filter activity"].tap()
        XCTAssertTrue(app.navigationBars["Filter activity"].waitForExistence(timeout: 5))
        app.buttons["Order, Newest first"].tap()
        app.buttons["Oldest first"].tap()
        app.buttons["Event, All events"].tap()
        app.buttons["Comment"].tap()
        capture(app, "activity-filter-controls")
        app.buttons["Done"].tap()
        XCTAssertEqual(app.buttons["Filter activity"].value as? String, "Active filters")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Oldest first")).firstMatch.exists)
        capture(app, "activity-filtered")
        app.buttons["Clear filters"].tap()
        XCTAssertEqual(app.buttons["Filter activity"].value as? String, "No filters")
        app.buttons["More pages"].tap()
        app.buttons["Skills"].tap()
        XCTAssertTrue(app.buttons["Filter Skills"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.navigationBars.buttons["Filters"].exists)
        capture(app, "skills-filter-icon")
        app.buttons["Filter Skills"].tap()
        XCTAssertTrue(app.navigationBars["Filter Skills"].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
    }
    @MainActor func testNavigationArrangementAndInventoryBrowsing() throws {
        let server = try XCTUnwrap(ProcessInfo.processInfo.environment["CENTCOM_UI_TEST_SERVER"], "Set CENTCOM_UI_TEST_SERVER to a running local CENTCOM server")
        let app = XCUIApplication()
        app.launchArguments = ["-serverAddress", server, "-navigation.startPage", "tasks", "-navigation.hidden.v1", ""]
        app.launch()
        XCTAssertTrue(app.buttons["More pages"].waitForExistence(timeout: 15))
        app.buttons["More pages"].tap()
        XCTAssertTrue(app.buttons["Arrange pages"].waitForExistence(timeout: 5))
        capture(app, "navigation-expanded")
        app.buttons["Arrange pages"].tap()
        XCTAssertTrue(app.navigationBars["Arrange pages"].waitForExistence(timeout: 5))
        capture(app, "navigation-arrange")
        // Reset through the same control people use, then move Skills into the first slot.
        resetNavigation(app)
        let skills = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Reorder Skills")).firstMatch
        let tasks = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Reorder Tasks")).firstMatch
        XCTAssertTrue(skills.waitForExistence(timeout: 5))
        skills.press(forDuration: 0.5, thenDragTo: tasks)
        app.buttons["Done"].tap()
        XCTAssertTrue(app.buttons["Skills"].waitForExistence(timeout: 5))
        app.buttons["Skills"].tap()
        XCTAssertTrue(app.textFields["Search Skills"].waitForExistence(timeout: 5))
        capture(app, "skills-iphone")
        app.buttons["Filter Skills"].tap()
        XCTAssertTrue(app.navigationBars["Filter Skills"].waitForExistence(timeout: 5))
        capture(app, "skills-filters-iphone")
        app.buttons["Done"].tap()
        app.buttons["Libraries"].tap()
        capture(app, "skills-libraries-iphone")
        app.terminate()
        app.launch()
        XCTAssertTrue(app.buttons["Skills"].waitForExistence(timeout: 10), "Custom navigation order must survive relaunch")
        app.buttons["More pages"].tap()
        app.buttons["Instructions"].tap()
        XCTAssertTrue(app.textFields["Search instructions"].waitForExistence(timeout: 5))
        app.buttons["Global"].tap()
        capture(app, "instructions-global-iphone")
        app.buttons["More pages"].tap()
        app.buttons["Agents"].tap()
        XCTAssertTrue(app.textFields["Find an agent"].waitForExistence(timeout: 5))
        capture(app, "agents-iphone")
        // Restore simulator navigation after verification.
        app.buttons["More pages"].tap()
        app.buttons["Arrange pages"].tap()
        resetNavigation(app)
        app.buttons["Done"].tap()
    }
    @MainActor func testMobileReviewFeedback() throws {
        let server = try XCTUnwrap(ProcessInfo.processInfo.environment["CENTCOM_UI_TEST_SERVER"])
        let app = XCUIApplication()
        app.launchArguments = ["-serverAddress", server]
        app.launch()
        XCTAssertTrue(app.buttons["More pages"].waitForExistence(timeout: 15))
        app.buttons["More pages"].tap()
        app.buttons["Arrange pages"].tap()
        resetNavigation(app)
        app.buttons["Done"].tap()
        app.terminate()
        app.launch()
        XCTAssertTrue(app.buttons["Projects"].waitForExistence(timeout: 15))
        app.buttons["Projects"].tap()
        let search = app.textFields["Search projects"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        let firstSearchY = search.frame.midY
        XCTAssertLessThan(search.frame.maxY, app.frame.height / 2, "Search must be at the top on the first visit")
        XCTAssertLessThan(search.frame.maxY, app.buttons["More pages"].frame.minY)
        capture(app, "projects-first-visit")
        search.tap(); search.typeText("CENTCOM")
        XCTAssertTrue(app.buttons["Clear search"].waitForExistence(timeout: 3))
        app.buttons["Clear search"].tap()
        search.typeText("\n")
        app.buttons["Tasks"].tap()
        app.buttons["Projects"].tap()
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        XCTAssertEqual(search.frame.midY, firstSearchY, accuracy: 2, "Returning must not change search placement")
        app.buttons["More pages"].tap()
        app.buttons["Instructions"].tap()
        XCTAssertTrue(app.buttons["Filter instructions"].waitForExistence(timeout: 5))
        let title = app.staticTexts["instructions-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertGreaterThan(title.frame.width, 95, "The full Instructions title must be visible")
        let leading = title.frame.minX
        XCTAssertLessThan(leading, app.frame.width / 4)
        for scope in ["All", "Global", "Projects"] {
            app.segmentedControls.buttons[scope].tap()
            XCTAssertEqual(title.frame.minX, leading, accuracy: 2)
            capture(app, "instructions-" + scope.lowercased())
        }
        app.buttons["Filter instructions"].tap()
        XCTAssertTrue(app.navigationBars["Filter Instructions"].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        app.buttons["More pages"].tap()
        app.buttons["Agents"].tap()
        XCTAssertTrue(app.textFields["Find an agent"].waitForExistence(timeout: 5))
        capture(app, "agents-robots")
        app.buttons["More pages"].tap()
        app.buttons["Arrange pages"].tap()
        let openingPage = app.buttons["opening-page-picker"]
        XCTAssertTrue(openingPage.waitForExistence(timeout: 5))
        openingPage.tap()
        app.buttons["opening-page-projects"].tap()
        XCTAssertEqual(openingPage.value as? String, "Projects")
        capture(app, "opening-page-projects")
        app.buttons["Done"].tap()
        app.terminate()
        // Remove launch overrides: the selected opening page must come from persisted preferences.
        app.launchArguments = ["-serverAddress", server]
        app.launch()
        XCTAssertTrue(app.textFields["Search projects"].waitForExistence(timeout: 15), "Projects must open after relaunch")
        capture(app, "opening-page-relaunched")
        app.buttons["More pages"].tap()
        app.buttons["Arrange pages"].tap()
        resetNavigation(app)
        app.buttons["Done"].tap()
    }
    @MainActor private func resetNavigation(_ app: XCUIApplication) {
        let list = app.collectionViews.element(boundBy: app.collectionViews.count - 1)
        for _ in 0..<4 {
            if app.buttons["Reset to default"].exists && app.buttons["Reset to default"].isHittable { break }
            list.swipeUp()
        }
        app.buttons["Reset to default"].tap()
        for _ in 0..<4 {
            if app.buttons["opening-page-picker"].exists && app.buttons["opening-page-picker"].isHittable { break }
            list.swipeDown()
        }
    }
    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
