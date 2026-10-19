//! The table windows: winit for the windows and the event loop, softbuffer
//! to present a frame drawn on the CPU (`rail_hud_sim::draw`). No GPU, so
//! it runs on CI runners and in virtual machines.
//!
//! One window per table, titled with the table's title (the room's format,
//! `rooms.json`); the process is `rail-hud-sim` and every frame says
//! "RAIL TABLE SIMULATOR". The simulator runs on the event loop's thread:
//! `about_to_wait` writes the hands that are due and sleeps until the next
//! one (`ControlFlow::WaitUntil`); commands from standard input and the
//! script arrive as user events.

use std::num::NonZeroU32;
use std::rc::Rc;
use std::time::{Duration, Instant};

use rail_hud_sim::command::Command;
use rail_hud_sim::draw::{Canvas, View, draw};
use rail_hud_sim::sim::{Event, Sim, speed_text};
use winit::application::ApplicationHandler;
use winit::dpi::{LogicalPosition, LogicalSize, PhysicalPosition, PhysicalSize};
use winit::event::{ElementState, MouseButton, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy};
use winit::keyboard::{Key, NamedKey};
use winit::window::{Window, WindowId};

use crate::{GuiOptions, emit};

type Surface = softbuffer::Surface<Rc<Window>, Rc<Window>>;

struct Win {
    table: u32,
    window: Rc<Window>,
    surface: Surface,
    title: String,
    version: u64,
    /// The first frame has been presented (reported as a `window` event).
    shown: bool,
    /// (R3.12) Where the pointer last was over the client area
    /// (physical pixels): where a click lands.
    cursor: (i32, i32),
}

struct App {
    sim: Sim,
    options: GuiOptions,
    windows: Vec<Win>,
    /// Tables whose window could not be made.
    failed: Vec<u32>,
    done_at: Option<Instant>,
    /// `window` events to send once the window has settled: (table, when).
    reports: Vec<(u32, Instant)>,
    code: i32,
}

/// How long after a window command or an OS move/resize its state is
/// reported (the OS may animate: a minimise takes a moment on macOS).
const SETTLE: Duration = Duration::from_millis(400);

/// Run the windows until `quit`, the last window closes, or `--hands` is
/// done. `sources` starts the command readers with a sender.
pub fn run(sim: Sim, options: GuiOptions, sources: impl FnOnce(EventLoopProxy<Command>)) -> i32 {
    let event_loop = match EventLoop::<Command>::with_user_event().build() {
        Ok(event_loop) => event_loop,
        Err(e) => {
            eprintln!("rail-hud-sim: no windows here ({e}); use --headless");
            return 1;
        }
    };
    sources(event_loop.create_proxy());
    let mut app = App {
        sim,
        options,
        windows: Vec::new(),
        failed: Vec::new(),
        done_at: None,
        reports: Vec::new(),
        code: 0,
    };
    if let Err(e) = event_loop.run_app(&mut app) {
        eprintln!("rail-hud-sim: {e}");
        return 1;
    }
    app.code
}

impl App {
    /// Report the table's window once it has settled.
    fn report_later(&mut self, table: u32) {
        let when = Instant::now() + SETTLE;
        self.reports.retain(|(t, _)| *t != table);
        self.reports.push((table, when));
    }

    /// Send the reports that are due; when the next one is.
    fn send_reports(&mut self, now: Instant) -> Option<Instant> {
        let (due, later): (Vec<_>, Vec<_>) = self.reports.iter().partition(|(_, at)| *at <= now);
        self.reports = later;
        for (table, _) in due {
            if let Some(win) = self.window_of(table) {
                let event = Self::window_event_of(win);
                self.sim.push_event(event);
            }
        }
        self.reports.iter().map(|(_, at)| *at).min()
    }

    fn window_of(&self, table: u32) -> Option<&Win> {
        self.windows.iter().find(|w| w.table == table)
    }

    /// Default client size and the grid position of the `index`-th window.
    fn placement(
        &self,
        event_loop: &ActiveEventLoop,
        index: usize,
        count: usize,
    ) -> (LogicalSize<u32>, LogicalPosition<i32>) {
        let [dw, dh] = self.sim.config.room.window;
        let (mut w, mut h) = self.options.window.unwrap_or((dw, dh));
        let screen = event_loop
            .primary_monitor()
            .or_else(|| event_loop.available_monitors().next())
            .map(|m| m.size().to_logical::<u32>(m.scale_factor()))
            .unwrap_or(LogicalSize::new(1920, 1080));
        let count = u32::try_from(count.max(1)).unwrap_or(1);
        let cols = (1..=count).find(|c| c * c >= count).unwrap_or(1);
        let rows = count.div_ceil(cols);
        // A grid cell: the window and its title bar (about 28 points).
        let cell_w = screen.width / cols;
        let cell_h = (screen.height.saturating_sub(30) / rows).saturating_sub(28);
        if self.options.window.is_none() && (w > cell_w || h > cell_h) {
            // Shrink to fit the grid, keeping the aspect, down to 400 wide.
            let k = (cell_w * 1000 / w.max(1)).min(cell_h * 1000 / h.max(1));
            let nw = (w * k / 1000).max(400);
            h = h * nw / w.max(1);
            w = nw;
        }
        let index = u32::try_from(index).unwrap_or(0);
        let (col, row) = (index % cols, index / cols);
        let mut x = col * w;
        let mut y = 30 + row * (h + 28);
        if x + w > screen.width || y + h > screen.height {
            // Does not fit: cascade.
            x = (index * 32) % screen.width.saturating_sub(w).max(1);
            y = 30 + (index * 32) % screen.height.saturating_sub(h).max(1);
        }
        (
            LogicalSize::new(w, h),
            LogicalPosition::new(i32::try_from(x).unwrap_or(0), i32::try_from(y).unwrap_or(0)),
        )
    }

    /// Windows for new tables, none for closed ones, titles kept current.
    fn sync(&mut self, event_loop: &ActiveEventLoop) {
        let open: Vec<u32> = self.sim.tables().iter().map(|t| t.id).collect();
        self.windows.retain(|w| open.contains(&w.table));
        let count = open.len();
        for (index, table) in self.sim.tables().to_vec().iter().enumerate() {
            if self.failed.contains(&table.id) {
                continue;
            }
            if let Some(win) = self.windows.iter_mut().find(|w| w.table == table.id) {
                if win.title != table.title {
                    win.window.set_title(&table.title);
                    win.title.clone_from(&table.title);
                }
                if win.version != table.version {
                    win.version = table.version;
                    win.window.request_redraw();
                }
                continue;
            }
            let (size, position) = self.placement(event_loop, index, count);
            let attributes = Window::default_attributes()
                .with_title(table.title.clone())
                .with_inner_size(size)
                .with_min_inner_size(LogicalSize::new(320, 240))
                .with_position(position)
                .with_active(false);
            let made = event_loop
                .create_window(attributes)
                .map_err(|e| e.to_string())
                .and_then(|window| {
                    let window = Rc::new(window);
                    let context =
                        softbuffer::Context::new(window.clone()).map_err(|e| e.to_string())?;
                    let surface =
                        Surface::new(&context, window.clone()).map_err(|e| e.to_string())?;
                    Ok((window, surface))
                });
            match made {
                Ok((window, surface)) => {
                    window.request_redraw();
                    self.windows.push(Win {
                        table: table.id,
                        window,
                        surface,
                        title: table.title.clone(),
                        version: table.version,
                        shown: false,
                        cursor: (0, 0),
                    });
                }
                Err(message) => {
                    self.failed.push(table.id);
                    self.code = 1;
                    self.sim.push_event(Event::Error {
                        message: format!("table {}: no window ({message})", table.id),
                    });
                }
            }
        }
    }

    fn window_event_of(win: &Win) -> Event {
        let position = win
            .window
            .outer_position()
            .unwrap_or(PhysicalPosition::new(0, 0));
        // The client area's origin (Windows: `ClientToScreen` of 0,0);
        // where a system cannot tell (Wayland), the frame's.
        let client = win.window.inner_position().unwrap_or(position);
        let size = win.window.inner_size();
        Event::Window {
            table: win.table,
            title: win.title.clone(),
            x: position.x,
            y: position.y,
            client_x: client.x,
            client_y: client.y,
            width: size.width,
            height: size.height,
            minimized: win.window.is_minimized().unwrap_or(false),
        }
    }

    fn redraw(&mut self, id: WindowId) {
        let Some(index) = self.windows.iter().position(|w| w.window.id() == id) else {
            return;
        };
        let room = self.sim.config.room.name.clone();
        let speed = speed_text(self.sim.config.speed);
        let paused = self.sim.paused();
        let Some(table) = self.sim.table(self.windows[index].table).cloned() else {
            return;
        };
        let win = &mut self.windows[index];
        let size = win.window.inner_size();
        let (Some(width), Some(height)) =
            (NonZeroU32::new(size.width), NonZeroU32::new(size.height))
        else {
            return;
        };
        if win.surface.resize(width, height).is_err() {
            return;
        }
        let Ok(mut buffer) = win.surface.buffer_mut() else {
            return;
        };
        let mut canvas = Canvas {
            pixels: &mut buffer,
            width: size.width,
            height: size.height,
        };
        draw(
            &mut canvas,
            &View {
                table: table.id,
                room: &room,
                title: &table.title,
                size: table.size,
                hero_seat: table.hero_seat,
                preferred_seat: self.options.preferred_seat,
                shown: table.shown.as_ref(),
                hands: table.hands,
                paused,
                speed: &speed,
            },
        );
        if buffer.present().is_ok() && !win.shown {
            win.shown = true;
            let event = Self::window_event_of(win);
            self.sim.push_event(event);
        }
    }

    /// A command: the window ones here, the rest to the simulator.
    fn command(&mut self, event_loop: &ActiveEventLoop, cmd: &Command) {
        let missing = |app: &mut Self, table: u32| {
            app.sim.push_event(Event::Error {
                message: format!("no window for table {table}"),
            });
        };
        match cmd {
            Command::Move(table, x, y) => match self.window_of(*table) {
                Some(win) => {
                    win.window.set_outer_position(PhysicalPosition::new(*x, *y));
                    self.report_later(*table);
                }
                None => missing(self, *table),
            },
            Command::Resize(table, w, h) => match self.window_of(*table) {
                Some(win) => {
                    let _ = win.window.request_inner_size(PhysicalSize::new(*w, *h));
                    self.report_later(*table);
                }
                None => missing(self, *table),
            },
            Command::Minimize(table) | Command::Restore(table) => match self.window_of(*table) {
                Some(win) => {
                    win.window
                        .set_minimized(matches!(cmd, Command::Minimize(_)));
                    self.report_later(*table);
                }
                None => missing(self, *table),
            },
            Command::Focus(table) => match self.window_of(*table) {
                Some(win) => {
                    win.window.focus_window();
                    self.report_later(*table);
                }
                None => missing(self, *table),
            },
            Command::Tile => {
                let count = self.windows.len();
                for index in 0..count {
                    let (size, position) = self.placement(event_loop, index, count);
                    let win = &self.windows[index];
                    win.window.set_outer_position(position);
                    let _ = win.window.request_inner_size(size);
                }
            }
            other => {
                if let Err(message) = self.sim.apply(other) {
                    self.sim.push_event(Event::Error { message });
                }
            }
        }
    }

    fn key(&mut self, event_loop: &ActiveEventLoop, id: WindowId, key: &Key) {
        let Some(win) = self.windows.iter().find(|w| w.window.id() == id) else {
            return;
        };
        let table = win.table;
        let nudge = |dx: i32, dy: i32| {
            let p = win
                .window
                .outer_position()
                .unwrap_or(PhysicalPosition::new(0, 0));
            Command::Move(table, p.x + dx, p.y + dy)
        };
        let cmd = match key {
            Key::Named(NamedKey::Space) => Command::TogglePause,
            Key::Named(NamedKey::ArrowLeft) => nudge(-20, 0),
            Key::Named(NamedKey::ArrowRight) => nudge(20, 0),
            Key::Named(NamedKey::ArrowUp) => nudge(0, -20),
            Key::Named(NamedKey::ArrowDown) => nudge(0, 20),
            Key::Character(c) => match c.to_lowercase().as_str() {
                "+" | "=" => Command::Faster,
                "-" => Command::Slower,
                "h" => Command::Hand(table),
                "t" => Command::TableMove(table),
                "n" => Command::Open(None),
                "w" => Command::Close(table),
                "m" => Command::Minimize(table),
                "q" => Command::Quit,
                _ => return,
            },
            _ => return,
        };
        self.command(event_loop, &cmd);
        for win in &self.windows {
            win.window.request_redraw();
        }
    }
}

impl ApplicationHandler<Command> for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        self.sync(event_loop);
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, cmd: Command) {
        self.command(event_loop, &cmd);
        for win in &self.windows {
            win.window.request_redraw();
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => {
                if let Some(table) = self
                    .windows
                    .iter()
                    .find(|w| w.window.id() == id)
                    .map(|w| w.table)
                {
                    self.command(event_loop, &Command::Close(table));
                }
            }
            WindowEvent::RedrawRequested => self.redraw(id),
            WindowEvent::Resized(_) | WindowEvent::Moved(_) => {
                if let Some(win) = self.windows.iter().find(|w| w.window.id() == id) {
                    win.window.request_redraw();
                    let table = win.table;
                    if win.shown {
                        self.report_later(table);
                    }
                }
            }
            // (R3.12) The overlay tests' proof that a click outside the
            // HUD's panels reached the table: a `clicked` event.
            WindowEvent::CursorMoved { position, .. } => {
                if let Some(win) = self.windows.iter_mut().find(|w| w.window.id() == id) {
                    #[allow(clippy::cast_possible_truncation)] // pixels, well inside i32
                    let at = (position.x.round() as i32, position.y.round() as i32);
                    win.cursor = at;
                }
            }
            WindowEvent::MouseInput {
                state: ElementState::Pressed,
                button: MouseButton::Left,
                ..
            } => {
                if let Some(win) = self.windows.iter().find(|w| w.window.id() == id) {
                    let (x, y) = win.cursor;
                    self.sim.push_event(Event::Clicked {
                        table: win.table,
                        x,
                        y,
                    });
                }
            }
            WindowEvent::KeyboardInput { event, .. } if event.state == ElementState::Pressed => {
                self.key(event_loop, id, &event.logical_key);
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        let now = Instant::now();
        self.sim.tick(now);
        self.sync(event_loop);
        let next_report = self.send_reports(now);
        emit(self.sim.take_events());
        if self.sim.should_quit() {
            event_loop.exit();
            return;
        }
        let mut wake = self.sim.next_due().unwrap_or(now + Duration::from_secs(1));
        if let Some(at) = next_report {
            wake = wake.min(at);
        }
        if self.sim.done() {
            // Leave once every window has shown a frame, after the linger.
            let all_shown = self.windows.iter().all(|w| w.shown);
            let done_at = *self.done_at.get_or_insert(now);
            if all_shown && now >= done_at + self.options.linger {
                event_loop.exit();
                return;
            }
            if now >= done_at + self.options.linger + Duration::from_secs(20) {
                eprintln!("rail-hud-sim: a window never showed a frame");
                self.code = 1;
                event_loop.exit();
                return;
            }
            wake = now + Duration::from_millis(100);
        }
        event_loop.set_control_flow(ControlFlow::WaitUntil(wake));
    }
}
