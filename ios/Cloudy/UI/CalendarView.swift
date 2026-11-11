import SwiftUI

private var cal: Calendar { Calendar.current }

private func startOf(_ e: CalEvent, master: Bool = false) -> Date {
    let s = master ? (e.masterStart ?? e.start) : e.start
    return e.isAllDay ? (dayFormatter.date(from: String(s.prefix(10))) ?? Date()) : (parseDate(s) ?? Date())
}

private func endOf(_ e: CalEvent, master: Bool = false) -> Date {
    let s = master ? (e.masterEnd ?? e.end) : e.end
    return e.isAllDay ? (dayFormatter.date(from: String(s.prefix(10))) ?? Date()) : (parseDate(s) ?? Date())
}

private func onDay(_ e: CalEvent, _ day: Date) -> Bool {
    let next = cal.date(byAdding: .day, value: 1, to: day)!
    let s = startOf(e), end = endOf(e)
    return s < next && (end > day || (end == s && s >= day))
}

struct CalendarView: View {
    @Environment(\.verticalSizeClass) private var heightClass
    @Environment(\.layoutDirection) private var layoutDirection
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var month = cal.dateInterval(of: .month, for: Date())!.start
    @State private var selected = cal.startOfDay(for: Date())
    @State private var calendars: [DavCollection]?
    @State private var events: [CalEvent] = []
    /// The events of each day in the grid, worked out once per load: every cell used to ask every event on each redraw.
    @State private var byDay: [Date: [CalEvent]] = [:]
    /// Whether the last month change went forward: the new month slides in from that side.
    @State private var forward = true
    @State private var loadError: String?
    @State private var editing: EditRequest?

    struct EditRequest: Identifiable {
        let id = UUID()
        let event: CalEvent?
        let day: Date
    }

    private func gridStart(_ month: Date) -> Date {
        let weekday = cal.component(.weekday, from: month)
        let offset = (weekday - cal.firstWeekday + 7) % 7
        return cal.date(byAdding: .day, value: -offset, to: month)!
    }

    private var compact: Bool { heightClass == .compact }

    var body: some View {
        NavigationStack {
            Group {
                if let loadError, calendars == nil {
                    ErrorState(message: loadError) { Task { await load() } }
                } else if compact {
                    // Landscape: the month and the selected day's events side by side instead of one long scroll.
                    HStack(spacing: 0) {
                        // Tight enough for the six weeks to fit between the bars without scrolling.
                        List { Section { monthGrid.listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12)) } }
                            .scrollBounceBehavior(.basedOnSize)
                            .contentMargins(.top, 0, for: .scrollContent)
                        List { daySection }
                            .contentMargins(.top, 0, for: .scrollContent)
                    }
                    .background(Color(.systemGroupedBackground))
                } else {
                    List {
                        Section { monthGrid }
                        daySection
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(month.formatted(.dateTime.month(.wide).year()))
            .toolbar {
                ToolbarItemGroup(placement: .topBarLeading) {
                    Button { shift(-1) } label: { Label("Previous month", systemImage: "chevron.backward") }
                    Button { shift(1) } label: { Label("Next month", systemImage: "chevron.forward") }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Today") { show(cal.dateInterval(of: .month, for: Date())!.start, select: cal.startOfDay(for: Date())) }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button { editing = EditRequest(event: nil, day: selected) } label: { Label("New event", systemImage: "plus") }
                        .disabled(calendars?.isEmpty ?? true)
                }
            }
            .refreshable { await load() }
            .task(id: month) { await load() }
            .onLiveChange(any: true) { Task { await load() } }
            #if DEBUG
            .onReceive(NotificationCenter.default.publisher(for: .tour)) { note in
                switch note.object as? Screenshots.Step {
                case .month(let n): shift(n)
                case .day(let n): withAnimation(.snappy(duration: 0.25)) { selected = cal.date(byAdding: .day, value: n, to: cal.startOfDay(for: Date()))! }
                default: break
                }
            }
            #endif
            .sheet(item: $editing) { req in
                EventEditor(event: req.event, day: req.day, calendars: calendars ?? []) { Task { await load() } }
            }
        }
    }

    /// The selected day: its events, a spinner until the first answer, or "No events".
    private var daySection: some View {
        Section(selected.formatted(date: .complete, time: .omitted)) {
            let today = eventsOn(selected).sorted { a, b in
                a.isAllDay != b.isAllDay ? a.isAllDay : startOf(a) < startOf(b)
            }
            if calendars == nil {
                ProgressView().frame(maxWidth: .infinity, minHeight: 60)
            } else if today.isEmpty {
                ContentUnavailableView("No events", systemImage: "calendar")
                    .padding(.vertical, compact ? 0 : -8) // the stock padding is made for a whole screen, not one row
            }
            ForEach(today) { e in
                Button { editing = EditRequest(event: e, day: selected) } label: { EventRow(event: e, color: color(e)) }
                    .foregroundStyle(.primary)
            }
        }
    }

    /// Weekday letters, then the month's six weeks. Changing month slides the weeks in the direction of travel (the next
    /// month comes from the trailing side, so it mirrors in Arabic); with Reduce Motion they cross-fade instead.
    private var monthGrid: some View {
        let symbols = cal.veryShortStandaloneWeekdaySymbols
        let first = cal.firstWeekday - 1
        let headers = Array(symbols[first...] + symbols[..<first])
        let slide: AnyTransition = reduceMotion ? .opacity : .asymmetric(
            insertion: .move(edge: forward ? .trailing : .leading).combined(with: .opacity),
            removal: .move(edge: forward ? .leading : .trailing).combined(with: .opacity))
        return VStack(spacing: compact ? 2 : 6) {
            HStack(spacing: 0) {
                ForEach(Array(headers.enumerated()), id: \.offset) { _, s in
                    Text(s).font(.caption2.bold()).foregroundStyle(.secondary).frame(maxWidth: .infinity)
                }
            }
            ZStack {
                weeks(of: month).id(month).transition(slide)
            }
            .clipped()
        }
        .padding(.vertical, 4)
        // Seven columns can't grow with the largest accessibility sizes (numbers turned into "…"); the selected day's
        // title and events below still use the full size.
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        .contentShape(Rectangle())
        .gesture(DragGesture(minimumDistance: 30).onEnded { v in
            guard abs(v.translation.width) > abs(v.translation.height) * 1.5 else { return }
            // Pulling the page toward the leading edge brings the next month, whichever way the language reads.
            shift((v.translation.width < 0) == (layoutDirection == .leftToRight) ? 1 : -1)
        })
    }

    private func weeks(of month: Date) -> some View {
        let start = gridStart(month)
        return LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 0), count: 7), spacing: compact ? 0 : 4) {
            ForEach(0..<42, id: \.self) { i in
                dayCell(cal.date(byAdding: .day, value: i, to: start)!, in: month)
            }
        }
    }

    private func dayCell(_ day: Date, in month: Date) -> some View {
        let inMonth = cal.isDate(day, equalTo: month, toGranularity: .month)
        let isSelected = day == selected
        let isToday = cal.isDateInToday(day)
        let dots = eventsOn(day).prefix(3)
        let circle: CGFloat = compact ? 26 : 32
        return Button {
            withAnimation(.snappy(duration: 0.25)) { selected = day }
        } label: {
            VStack(spacing: compact ? 1 : 3) {
                Text("\(cal.component(.day, from: day))")
                    .font(.callout.weight(isToday ? .bold : .regular))
                    .lineLimit(1).minimumScaleFactor(0.6) // never "…" in the circle
                    .foregroundStyle(isSelected ? Color.white : isToday ? Color.accentColor : inMonth ? Color.primary : Color.secondary.opacity(0.6))
                    .frame(width: circle, height: circle)
                    .background {
                        // Today keeps a faint disc; the selected day's solid one grows in and fades out.
                        if isToday { Circle().fill(Color.accentColor.opacity(0.14)) }
                        Circle().fill(Color.solidAccent).scaleEffect(isSelected ? 1 : 0.6).opacity(isSelected ? 1 : 0)
                    }
                HStack(spacing: 2) {
                    ForEach(Array(dots.enumerated()), id: \.offset) { _, e in Circle().fill(color(e)).frame(width: 5, height: 5) }
                }
                .frame(height: 5)
            }
            .frame(maxWidth: .infinity, minHeight: compact ? 34 : 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(day.formatted(date: .complete, time: .omitted))
        .accessibilityValue(dots.isEmpty ? Text(verbatim: "") : Text("Has events"))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private func color(_ e: CalEvent) -> Color {
        Color(hex: calendars?.first { $0.id == e.calendarId }?.color) ?? .accentColor
    }

    /// A day outside the loaded grid (it can be selected while another month is on its way) is looked up directly.
    private func eventsOn(_ day: Date) -> [CalEvent] { byDay[day] ?? events.filter { onDay($0, day) } }

    private func shift(_ months: Int) {
        let target = cal.date(byAdding: .month, value: months, to: month)!
        show(target, select: target)
    }

    private func show(_ target: Date, select day: Date) {
        guard target != month else { withAnimation(.snappy(duration: 0.25)) { selected = day }; return }
        forward = target > month
        // The month that leaves takes its exit side from `forward` as it was last drawn, so the change waits one pass.
        DispatchQueue.main.async {
            withAnimation(.snappy(duration: 0.35)) {
                month = target
                selected = day
            }
        }
    }

    private func load() async {
        let requested = month
        do {
            let cals = try await API.shared.calendars()
            let from = gridStart(month), to = cal.date(byAdding: .day, value: 42, to: from)!
            var all: [CalEvent] = []
            for c in cals { all += try await API.shared.events(c.id, from: from, to: to) }
            var days: [Date: [CalEvent]] = [:]
            for i in 0..<42 {
                let day = cal.date(byAdding: .day, value: i, to: from)!
                days[day] = all.filter { onDay($0, day) }
            }
            // A reload started for another month (a live update just before a swipe) must not replace this month's events.
            guard requested == month else { return }
            // Dots and rows fade in rather than pop; the very first load just shows.
            withAnimation(calendars == nil ? nil : .easeOut(duration: 0.2)) {
                calendars = cals
                events = all
                byDay = days
            }
            loadError = nil
        } catch is CancellationError {
        } catch let e as URLError where e.code == .cancelled {
        } catch {
            loadError = errorText(error)
        }
    }
}

private struct EventRow: View {
    let event: CalEvent
    let color: Color
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .subheadline) private var timeWidth: CGFloat = 70

    var body: some View {
        // Time column, calendar color bar, then title and place (the same layout as Android's event cards). At the
        // accessibility sizes the times move above the title, where they have the row's whole width.
        let large = typeSize.isAccessibilitySize
        HStack(spacing: 10) {
            if !large {
                VStack(alignment: .leading, spacing: 1) {
                    if event.isAllDay {
                        Text("All day").font(.subheadline.weight(.semibold))
                    } else {
                        Text(startOf(event).formatted(date: .omitted, time: .shortened)).font(.subheadline.weight(.semibold))
                        Text(endOf(event).formatted(date: .omitted, time: .shortened)).font(.caption).foregroundStyle(.secondary)
                    }
                }
                .frame(width: timeWidth, alignment: .leading)
            }
            RoundedRectangle(cornerRadius: 2).fill(color).frame(width: 4).frame(minHeight: 36)
            VStack(alignment: .leading, spacing: 2) {
                if large {
                    Group {
                        if event.isAllDay { Text("All day") } else {
                            Text(verbatim: "\(startOf(event).formatted(date: .omitted, time: .shortened)) – \(endOf(event).formatted(date: .omitted, time: .shortened))")
                        }
                    }
                    .font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                }
                Text((event.summary ?? "").isEmpty ? String(localized: "(no title)") : event.summary!).font(.body.weight(.medium))
                    .lineLimit(large ? 3 : 2)
                if let loc = event.location, !loc.isEmpty { Text(loc).font(.footnote).foregroundStyle(.secondary).lineLimit(large ? 2 : 1) }
            }
            Spacer(minLength: 0)
            if event.recurring == true { Image(systemName: "repeat").font(.footnote).foregroundStyle(.secondary) }
        }
        .fixedSize(horizontal: false, vertical: true) // lets the color bar take the row's height
    }
}

extension Color {
    /// `#RRGGBB` (calendar colors from the server).
    init?(hex: String?) {
        guard var s = hex?.trimmingCharacters(in: .whitespaces), !s.isEmpty else { return nil }
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count >= 6, let v = UInt32(s.prefix(6), radix: 16) else { return nil }
        self.init(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }
}

/// Create or edit an event. Repeating events are edited as a whole series.
struct EventEditor: View {
    let event: CalEvent?
    let calendars: [DavCollection]
    let onDone: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var allDay: Bool
    @State private var start: Date
    @State private var end: Date
    @State private var repeatRule: String
    @State private var location: String
    @State private var notes: String
    @State private var calendarId: Int64
    @State private var saving = false
    @State private var confirmDelete = false
    @State private var error: String?

    init(event: CalEvent?, day: Date, calendars: [DavCollection], onDone: @escaping () -> Void) {
        self.event = event
        self.calendars = calendars
        self.onDone = onDone
        _title = State(initialValue: event?.summary ?? "")
        _allDay = State(initialValue: event?.isAllDay ?? false)
        _repeatRule = State(initialValue: (event?.rrule ?? "").uppercased())
        _location = State(initialValue: event?.location ?? "")
        _notes = State(initialValue: event?.description ?? "")
        _calendarId = State(initialValue: event?.calendarId ?? calendars.first?.id ?? 0)
        if let event {
            let s = startOf(event, master: true)
            var e = endOf(event, master: true)
            if event.isAllDay { e = cal.date(byAdding: .day, value: -1, to: e) ?? e } // stored end is exclusive
            _start = State(initialValue: s)
            _end = State(initialValue: max(e, s))
        } else {
            let base = cal.isDateInToday(day)
                ? cal.nextDate(after: Date(), matching: DateComponents(minute: 0), matchingPolicy: .nextTime)!
                : cal.date(bySettingHour: 9, minute: 0, second: 0, of: day)!
            _start = State(initialValue: base)
            _end = State(initialValue: base.addingTimeInterval(3600))
        }
    }

    private var endBeforeStart: Bool {
        allDay ? cal.startOfDay(for: end) < cal.startOfDay(for: start) : end < start
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Title", text: $title)
                    TextField("Location", text: $location)
                }
                Section {
                    Toggle("All day", isOn: $allDay)
                    DatePicker("Starts", selection: $start, displayedComponents: allDay ? .date : [.date, .hourAndMinute])
                    DatePicker("Ends", selection: $end, displayedComponents: allDay ? .date : [.date, .hourAndMinute])
                    Picker("Repeat", selection: $repeatRule) {
                        Text("Never").tag("")
                        Text("Every day").tag("DAILY")
                        Text("Every week").tag("WEEKLY")
                        Text("Every month").tag("MONTHLY")
                        Text("Every year").tag("YEARLY")
                    }
                } footer: {
                    if endBeforeStart {
                        Text("The end is before the start").foregroundStyle(.red)
                    } else if event?.recurring == true {
                        Text("Changes apply to all repeats of this event.")
                    }
                }
                if event == nil && calendars.count > 1 {
                    Picker("Calendar", selection: $calendarId) {
                        ForEach(calendars) { c in Text(c.name).tag(c.id) }
                    }
                }
                Section("Notes") {
                    TextField("Notes", text: $notes, axis: .vertical).lineLimit(3...10)
                }
                if event != nil {
                    Section {
                        Button("Delete event", role: .destructive) { confirmDelete = true }
                    }
                }
            }
            .onChange(of: start) { old, new in
                // Keep the duration. All-day events move by whole days: a time interval across a daylight-saving change
                // is an hour short or long and could land the end on the day before (a 2-day event became 1 day).
                if allDay, let days = cal.dateComponents([.day], from: cal.startOfDay(for: old), to: cal.startOfDay(for: new)).day {
                    end = cal.date(byAdding: .day, value: days, to: end) ?? end
                } else {
                    end = end.addingTimeInterval(new.timeIntervalSince(old))
                }
            }
            .navigationTitle(event == nil ? "New event" : "Edit event")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if saving { ProgressView() } else { Button("Save", action: save).bold().disabled(endBeforeStart) }
                }
            }
            .confirmationDialog(event?.recurring == true ? "Delete all repeats of this event?" : "Delete this event?",
                                isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive, action: delete)
            }
            .interactiveDismissDisabled(saving)
            .errorAlert($error)
        }
    }

    private func save() {
        let s: String, e: String
        if allDay {
            s = dayFormatter.string(from: start)
            e = dayFormatter.string(from: cal.date(byAdding: .day, value: 1, to: end)!)
        } else {
            s = isoString(start)
            e = isoString(end)
        }
        let input = EventInput(summary: title.trimmingCharacters(in: .whitespaces), start: s, end: e, allDay: allDay,
                               location: location, description: notes, rrule: repeatRule)
        saving = true
        Task {
            do {
                if let event { try await API.shared.updateEvent(event.calendarId, uri: event.uri, input) }
                else { try await API.shared.createEvent(calendarId, input) }
                onDone()
                dismiss()
            } catch {
                self.error = errorText(error) // keep the editor open so nothing typed is lost
            }
            saving = false
        }
    }

    private func delete() {
        guard let event else { return }
        Task {
            do {
                try await API.shared.deleteEvent(event.calendarId, uri: event.uri)
                onDone()
                dismiss()
            } catch {
                self.error = errorText(error)
            }
        }
    }
}
