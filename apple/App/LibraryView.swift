import SwiftUI

struct LibraryView: View {
    @Environment(AppModel.self) private var model
    @State private var query = ""
    @State private var pendingDelete: PageSummary?

    private var shown: [PageSummary] {
        model.pages.filter { Library.matches($0, query) }
    }

    var body: some View {
        Group {
            if !model.storageAvailable {
                ContentUnavailableView {
                    Label("Storage is not available", systemImage: "externaldrive.badge.exclamationmark")
                } description: {
                    Text("This build has no App Group, so the app cannot see the notes Safari keeps. Sign the app and the extension with a team, then build again.")
                }
            } else if model.loaded && model.pages.isEmpty {
                ContentUnavailableView {
                    Label("No notes yet", systemImage: "pencil.tip")
                } description: {
                    Text("Write on any page in Safari. Pages with ink show up here.")
                }
            } else if !query.isEmpty && shown.isEmpty {
                ContentUnavailableView.search(text: query)
            } else {
                List {
                    ForEach(shown) { page in
                        PageRow(page: page)
                            .contentShape(Rectangle())
                            .onTapGesture { open(page) }
                            .contextMenu {
                                Button("Open in Safari", systemImage: "safari") { open(page) }
                                Divider()
                                Button("Delete Notes…", systemImage: "trash", role: .destructive) { pendingDelete = page }
                            }
                            .swipeActions(edge: .trailing) {
                                Button("Delete", systemImage: "trash", role: .destructive) { pendingDelete = page }
                            }
                    }
                }
                #if os(macOS)
                .listStyle(.inset(alternatesRowBackgrounds: false))
                #else
                .listStyle(.insetGrouped)
                #endif
            }
        }
        .navigationTitle("Notes")
        .searchable(text: $query, prompt: "Search titles, addresses and quotes")
        .toolbar {
            ToolbarItem {
                Button {
                    Task { await model.refresh() }
                } label: {
                    if model.syncing {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                }
                .help("Read the notes again and sync")
                .disabled(model.syncing)
            }
        }
        .refreshable { await model.refresh() }
        .confirmationDialog(
            "Delete the notes on this page?",
            isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
            titleVisibility: .visible,
            presenting: pendingDelete
        ) { page in
            Button("Delete Notes", role: .destructive) {
                Task { await model.delete(page) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { page in
            Text("The notes on “\(page.title)” go away here, in Safari and in the place you chose.")
        }
    }

    private func open(_ page: PageSummary) {
        if let url = URL(string: page.record.address), url.scheme == "https" || url.scheme == "http" {
            Platform.openInSafari(url)
        }
    }
}

struct PageRow: View {
    let page: PageSummary

    var body: some View {
        HStack(spacing: 14) {
            InkPreview(notes: page.notes)
                .frame(width: 88, height: 60)
            VStack(alignment: .leading, spacing: 3) {
                Text(page.title)
                    .font(.headline)
                    .lineLimit(2)
                Text(page.record.host)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    Text(page.updated, format: .dateTime.day().month(.abbreviated).year())
                    Text("·")
                    Text(noteCount)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    private var noteCount: String {
        let n = page.notes.count
        return n == 1 ? "1 note" : "\(n) notes"
    }
}
