import SwiftUI

/// Matches the small outline robot used for agents in the desktop client.
struct AgentRobotIcon: View {
    var body: some View {
        RobotOutline().stroke(style: StrokeStyle(lineWidth: 1.75, lineCap: .round, lineJoin: .round))
            .aspectRatio(1, contentMode: .fit).accessibilityHidden(true)
    }

    private struct RobotOutline: Shape {
        func path(in rect: CGRect) -> Path {
            var path = Path()
            path.addRoundedRect(in: CGRect(x: 4, y: 8, width: 16, height: 12), cornerSize: CGSize(width: 2, height: 2))
            path.move(to: CGPoint(x: 12, y: 8)); path.addLine(to: CGPoint(x: 12, y: 4)); path.addLine(to: CGPoint(x: 9, y: 4))
            for x in [2.0, 22.0] {
                path.move(to: CGPoint(x: x, y: 12)); path.addLine(to: CGPoint(x: x, y: 16))
            }
            for x in [9.0, 15.0] {
                path.move(to: CGPoint(x: x, y: 13)); path.addLine(to: CGPoint(x: x, y: 15))
            }
            return path.applying(CGAffineTransform(scaleX: rect.width / 24, y: rect.height / 24).translatedBy(x: rect.minX, y: rect.minY))
        }
    }
}
