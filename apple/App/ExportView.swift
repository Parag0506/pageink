import SwiftUI
import UniformTypeIdentifiers

extension UTType {
    static let markdownText = UTType("net.daringfireball.markdown") ?? .plainText
}

/// Bytes handed to the save panel.
struct ExportDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.zip, .markdownText] }
    var data: Data

    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws {
        data = configuration.file.regularFileContents ?? Data()
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}

/// A file built only when the reader shares it.
struct SharedExport: Transferable {
    var fileName: String
    var make: @Sendable () throws -> Data

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(exportedContentType: .data) { item in
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let url = dir.appendingPathComponent(item.fileName)
            try item.make().write(to: url)
            return SentTransferredFile(url)
        }
    }
}

struct ExportView: View {
    @Environment(AppModel.self) private var model
    @State private var exportDoc: ExportDocument?
    @State private var exportType: UTType = .zip
    @State private var exportName = ""
    @State private var importing = false

    private var archiveName: String { "\(AppInfo.name) Notes \(AppModel.fileStamp()).zip" }
    private var markdownName: String { "\(AppInfo.name) Notes \(AppModel.fileStamp()).md" }

    var body: some View {
        Form {
            Section {
                ShareLink(item: SharedExport(fileName: archiveName, make: { [model] in try model.archiveData() }),
                          preview: SharePreview(archiveName)) {
                    Label("Share Archive", systemImage: "square.and.arrow.up")
                }
                Button {
                    save(type: .zip, name: archiveName) { try model.archiveData() }
                } label: {
                    Label("Save Archive…", systemImage: "archivebox")
                }
            } header: {
                Text("Everything")
            } footer: {
                Text("A zip file with the same layout as the folder: **pages**, one **.ink.json** file per page. Import it on any device.")
            }

            Section {
                ShareLink(item: SharedExport(fileName: markdownName, make: { [text = model.markdown()] in Data(text.utf8) }),
                          preview: SharePreview(markdownName)) {
                    Label("Share as Markdown", systemImage: "square.and.arrow.up")
                }
                Button {
                    save(type: .markdownText, name: markdownName) { Data(model.markdown().utf8) }
                } label: {
                    Label("Save as Markdown…", systemImage: "doc.plaintext")
                }
            } header: {
                Text("Notes as text")
            } footer: {
                Text("Each page with its title, address, the passages you marked and the dates.")
            }

            Section {
                Button {
                    importing = true
                } label: {
                    Label("Import Archive…", systemImage: "square.and.arrow.down")
                }
            } footer: {
                Text("Notes from the archive join the notes you have. Nothing is replaced.")
            }

            if let notice = model.notice {
                Section {
                    Label(notice, systemImage: "checkmark.circle")
                }
            }
        }
        .formStyle(.grouped)
        .disabled(!model.storageAvailable)
        .navigationTitle("Export and Import")
        .fileExporter(isPresented: Binding(get: { exportDoc != nil }, set: { if !$0 { exportDoc = nil } }),
                      document: exportDoc, contentType: exportType, defaultFilename: exportName) { result in
            if case .success = result { model.notice = "Saved." }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.zip]) { result in
            if case .success(let url) = result {
                Task { await model.importArchive(from: url) }
            }
        }
    }

    private func save(type: UTType, name: String, _ make: () throws -> Data) {
        do {
            exportType = type
            exportName = name
            exportDoc = ExportDocument(data: try make())
        } catch {
            model.notice = "The export failed. \(error.localizedDescription)"
        }
    }
}
