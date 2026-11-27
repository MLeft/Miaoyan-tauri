use std::collections::HashMap;
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};

#[derive(Clone, Default)]
pub struct ScanState(Arc<Mutex<HashMap<String, WindowScans>>>);

struct WindowScans { session: String, lanes: HashMap<String, Lane> }
struct Lane { generation: u64, active: Option<Arc<AtomicBool>> }

pub struct ScanRun {
    state: ScanState,
    window: String,
    session: String,
    lane: String,
    generation: u64,
    canceled: Arc<AtomicBool>,
}

impl ScanState {
    pub fn open(&self, window: &str) -> String {
        let mut windows = self.0.lock().unwrap();
        if let Some(previous) = windows.remove(window) {
            for lane in previous.lanes.into_values() {
                if let Some(active) = lane.active { active.store(true, Ordering::Release); }
            }
        }
        let session = uuid::Uuid::new_v4().to_string();
        windows.insert(window.to_owned(), WindowScans { session: session.clone(), lanes: HashMap::new() });
        session
    }

    pub fn begin(&self, window: &str, session: &str, lane: &str, generation: u64) -> Option<ScanRun> {
        let mut windows = self.0.lock().unwrap();
        let current = windows.get_mut(window)?;
        if current.session != session { return None; }
        let entry = current.lanes.entry(lane.to_owned()).or_insert(Lane { generation: 0, active: None });
        if generation < entry.generation || (generation == entry.generation && entry.active.is_some()) { return None; }
        if let Some(active) = entry.active.take() { active.store(true, Ordering::Release); }
        entry.generation = generation;
        let canceled = Arc::new(AtomicBool::new(false));
        entry.active = Some(canceled.clone());
        Some(ScanRun { state: self.clone(), window: window.to_owned(), session: session.to_owned(), lane: lane.to_owned(), generation, canceled })
    }

    pub fn invalidate(&self, window: &str, session: &str, lane: &str, generation: u64) {
        let mut windows = self.0.lock().unwrap();
        let Some(current) = windows.get_mut(window) else { return; };
        if current.session != session { return; }
        let entry = current.lanes.entry(lane.to_owned()).or_insert(Lane { generation: 0, active: None });
        if generation > entry.generation {
            entry.generation = generation;
            if let Some(active) = entry.active.take() { active.store(true, Ordering::Release); }
        }
    }

    pub fn release(&self, window: &str, session: &str, lane: &str, generation: u64) {
        let mut windows = self.0.lock().unwrap();
        let Some(current) = windows.get_mut(window) else { return; };
        if current.session == session && current.lanes.get(lane).is_some_and(|entry| entry.generation <= generation && entry.active.is_none()) {
            current.lanes.remove(lane);
        }
    }

    pub fn stop(&self, window: &str) {
        if let Some(current) = self.0.lock().unwrap().remove(window) {
            for lane in current.lanes.into_values() {
                if let Some(active) = lane.active { active.store(true, Ordering::Release); }
            }
        }
    }
}

impl ScanRun {
    pub fn is_cancelled(&self) -> bool { self.canceled.load(Ordering::Acquire) }
}

impl Drop for ScanRun {
    fn drop(&mut self) {
        let mut windows = self.state.0.lock().unwrap();
        if let Some(current) = windows.get_mut(&self.window) {
            if current.session == self.session {
                if let Some(lane) = current.lanes.get_mut(&self.lane) {
                    if lane.generation == self.generation && lane.active.as_ref().is_some_and(|active| Arc::ptr_eq(active, &self.canceled)) { lane.active = None; }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_before_start_rejects_old_work_and_late_cancel_keeps_new_work() {
        let state = ScanState::default();
        let session = state.open("main");
        state.invalidate("main", &session, "notes", 2);
        assert!(state.begin("main", &session, "notes", 1).is_none());
        let current = state.begin("main", &session, "notes", 3).unwrap();
        state.invalidate("main", &session, "notes", 2);
        assert!(!current.is_cancelled());
        state.invalidate("main", &session, "notes", 4);
        assert!(current.is_cancelled());
    }

    #[test]
    fn independent_import_and_project_lanes_are_not_canceled_with_notes() {
        let state = ScanState::default();
        let session = state.open("main");
        let notes = state.begin("main", &session, "notes", 1).unwrap();
        let projects = state.begin("main", &session, "projects", 2).unwrap();
        let import = state.begin("main", &session, "folder:C:/extra", 3).unwrap();
        state.invalidate("main", &session, "notes", 4);
        assert!(notes.is_cancelled());
        assert!(!projects.is_cancelled());
        assert!(!import.is_cancelled());
        state.stop("main");
        assert!(projects.is_cancelled());
        assert!(import.is_cancelled());
        assert!(state.begin("main", &session, "notes", 5).is_none());
    }

    #[test]
    fn session_replacement_and_old_run_drop_cannot_cancel_or_remove_the_new_run() {
        let state = ScanState::default();
        let first = state.open("main");
        let old = state.begin("main", &first, "notes", 1).unwrap();
        let second = state.open("main");
        assert!(old.is_cancelled());
        assert!(state.begin("main", &first, "notes", 100).is_none());
        let new = state.begin("main", &second, "notes", 1).unwrap();
        drop(old);
        assert!(!new.is_cancelled());
        assert!(state.begin("main", &second, "notes", 1).is_none());
        state.invalidate("main", &second, "notes", 2);
        assert!(new.is_cancelled());
    }

    #[test]
    fn release_of_an_old_or_active_lane_cannot_forget_a_current_cancellation_barrier() {
        let state = ScanState::default();
        let session = state.open("main");
        let run = state.begin("main", &session, "notes", 1).unwrap();
        state.release("main", &session, "notes", 1);
        assert!(state.begin("main", &session, "notes", 1).is_none());
        state.invalidate("main", &session, "notes", 3);
        state.release("main", &session, "notes", 1);
        assert!(state.begin("main", &session, "notes", 2).is_none());
        drop(run);
        state.release("main", &session, "notes", 3);
        let next = state.begin("main", &session, "notes", 4).unwrap();
        assert!(!next.is_cancelled());
    }
}
