import SwiftUI

/// A toolbar has exactly one scroll axis. Pinning content height and disabling
/// inset adjustment prevents diagonal swipes and keyboard changes from moving it vertically.
struct LockedHorizontalBar<Content: View>: View {
    @ScaledMetric(relativeTo: .body) private var height = 44.0
    @ViewBuilder var content: Content
    var body: some View {
        HorizontalBarHost(content: content).frame(height: height)
    }
}

private struct HorizontalBarHost<Content: View>: UIViewControllerRepresentable {
    let content: Content
    func makeUIViewController(context: Context) -> HorizontalBarController {
        HorizontalBarController(content: AnyView(content.environment(\.self, context.environment)))
    }
    func updateUIViewController(_ controller: HorizontalBarController, context: Context) {
        controller.host.rootView = AnyView(content.environment(\.self, context.environment))
        controller.host.view.invalidateIntrinsicContentSize()
    }
}

final class HorizontalOnlyScrollView: UIScrollView {
    override var contentOffset: CGPoint {
        get { super.contentOffset }
        set { super.contentOffset = CGPoint(x: newValue.x, y: 0) }
    }
    override func setContentOffset(_ contentOffset: CGPoint, animated: Bool) {
        super.setContentOffset(CGPoint(x: contentOffset.x, y: 0), animated: animated)
    }
}

final class HorizontalBarController: UIViewController {
    let scrollView = HorizontalOnlyScrollView()
    let host: UIHostingController<AnyView>
    init(content: AnyView) {
        host = UIHostingController(rootView: content)
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.showsVerticalScrollIndicator = false
        scrollView.bounces = false
        scrollView.alwaysBounceVertical = false
        scrollView.isDirectionalLockEnabled = true
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.keyboardDismissMode = .none
        view.addSubview(scrollView)
        addChild(host)
        host.sizingOptions = .intrinsicContentSize
        host.safeAreaRegions = []
        host.view.backgroundColor = .clear
        host.view.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(host.view)
        host.didMove(toParent: self)
        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: view.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            host.view.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor),
            host.view.heightAnchor.constraint(equalTo: scrollView.frameLayoutGuide.heightAnchor)
        ])
    }
}
