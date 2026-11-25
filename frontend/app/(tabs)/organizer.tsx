import { useCallback, useEffect, useRef, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type GestureResponderEvent,
  type ListRenderItemInfo,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useRouter } from 'expo-router';

import { COLORS } from '@/constants/theme';
import { useAuth } from '@/contexts/AuthContext';
import {
  ingestDriveFolder,
  getIngestStatus,
  getPhotos,
  getStats,
  photoProxyUrl,
  previewDriveFolder,
  getConfig,
  updateConfig,
  deleteEvent,
  deletePhoto,
  identifyFace,
  apiSaveEvent,
  apiGetEvents,
  type DbEvent,
  type FolderPreview,
  type IngestStatus,
  type PhotoItem,
  type PhotoMatch,
  type StatsResponse,
  type AppConfig,
} from '@/lib/api';

const GALLERY_COLS = 3;

export default function OrganizerScreen() {
  const router = useRouter();
  const { user, logout } = useAuth();
  const [savedEvents, setSavedEvents] = useState<DbEvent[]>([]);
  
  // Modals
  const [sheetVisible, setSheetVisible] = useState(false);
  const [testModalVisible, setTestModalVisible] = useState(false);

  // Create Event Form Inputs
  const [eventNameInput, setEventNameInput] = useState('');
  const [eventPasswordInput, setEventPasswordInput] = useState('');
  const [folderInput, setFolderInput] = useState('');
  const [createError, setCreateError] = useState('');

  // Active event view
  const [activeEventId, setActiveEventId] = useState('');
  const [copiedLink, setCopiedLink] = useState(false);

  // Config
  const [config, setConfig] = useState<AppConfig | null>(null);

  // Already-indexed stats
  const [stats, setStats] = useState<StatsResponse | null>(null);

  // Gallery (strictly scoped to activeEventId)
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [galleryPage, setGalleryPage] = useState(0);
  const [galleryTotal, setGalleryTotal] = useState(0);
  const [loadingGallery, setLoadingGallery] = useState(false);
  const [selectedPhoto, setSelectedPhoto] = useState<PhotoItem | null>(null);

  // Folder preview state
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [folderData, setFolderData] = useState<FolderPreview | null>(null);
  const [error, setError] = useState('');

  // Ingestion state
  const [isIngesting, setIsIngesting] = useState(false);
  const [ingestProgress, setIngestProgress] = useState<IngestStatus | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Test Event state (for photographer testing face search on this event)
  const [testImageUri, setTestImageUri] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [testMatches, setTestMatches] = useState<PhotoMatch[]>([]);
  const [testFacesCount, setTestFacesCount] = useState(0);
  const [testError, setTestError] = useState('');
  const testFileInputRef = useRef<HTMLInputElement | null>(null);

  // ── Load stats & gallery for active event ─────────────────────────────────

  const loadStats = useCallback(async (eventId: string) => {
    if (!eventId) {
      setStats(null);
      return;
    }
    try {
      const s = await getStats(eventId);
      setStats(s);
    } catch {
      // non-fatal
    }
  }, []);

  const loadGalleryPage = useCallback(async (page: number, append = false, eventId = activeEventId) => {
    if (!eventId) {
      setPhotos([]);
      setGalleryTotal(0);
      return;
    }
    setLoadingGallery(true);
    try {
      const data = await getPhotos(page, 24, eventId);
      setGalleryTotal(data.total);
      setPhotos(prev => (append ? [...prev, ...data.photos] : data.photos));
      setGalleryPage(page);
    } catch {
      // non-fatal
    } finally {
      setLoadingGallery(false);
    }
  }, [activeEventId]);

  const loadConfig = useCallback(async () => {
    try {
      const c = await getConfig();
      setConfig(c);
    } catch {}
  }, []);

  const loadEvents = useCallback(async () => {
    if (!user?.id) return;
    try {
      const evts = await apiGetEvents(user.id);
      setSavedEvents(evts);

      if (evts.length > 0) {
        // If current activeEventId is not in the list, default to first event
        const exists = evts.some(e => e.event_id === activeEventId);
        const selectedId = exists ? activeEventId : evts[0].event_id;
        setActiveEventId(selectedId);
        loadStats(selectedId);
        loadGalleryPage(0, false, selectedId);
      } else {
        // Zero events: ensure photos and stats are empty
        setActiveEventId('');
        setPhotos([]);
        setGalleryTotal(0);
        setStats(null);
      }
    } catch {}
  }, [user?.id, activeEventId, loadStats, loadGalleryPage]);

  useEffect(() => {
    loadConfig();
    loadEvents();
  }, [loadConfig, loadEvents]);

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // ── Switch Active Event ─────────────────────────────────────────────────────

  const handleSelectEvent = (eid: string) => {
    setActiveEventId(eid);
    loadStats(eid);
    loadGalleryPage(0, false, eid);
  };

  // ── Modal & Connect ─────────────────────────────────────────────────────────

  const openCreateSheet = () => {
    setCreateError('');
    setError('');
    setEventNameInput('');
    setEventPasswordInput('');
    setFolderInput('');
    setFolderData(null);
    setSheetVisible(true);
  };

  const closeCreateSheet = () => setSheetVisible(false);

  const preventClose = (event: GestureResponderEvent) => {
    event.stopPropagation();
  };

  const onConnectAndCreate = async () => {
    const name = eventNameInput.trim();
    const pwd = eventPasswordInput.trim();
    const link = folderInput.trim();

    if (!name) {
      setCreateError('Please enter an event name.');
      return;
    }
    if (!link) {
      setCreateError('Please enter a Google Drive folder link or ID.');
      return;
    }

    setIsLoadingPreview(true);
    setCreateError('');
    setError('');

    try {
      // 1. Preview folder to verify link
      const preview = await previewDriveFolder(link);
      setFolderData(preview);
      closeCreateSheet();

      // 2. Save event to database with auto-generated event_id
      if (user?.id) {
        const saved = await apiSaveEvent(user.id, name, pwd, link);
        setActiveEventId(saved.event_id);
        
        // 3. Immediately start ingestion for this event
        setIsIngesting(true);
        setIngestProgress(null);
        await ingestDriveFolder(link, saved.event_id);

        // 4. Poll progress
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = setInterval(async () => {
          try {
            const status = await getIngestStatus();
            setIngestProgress(status);
            if (!status.running) {
              if (pollRef.current) clearInterval(pollRef.current);
              pollRef.current = null;
              setIsIngesting(false);
              loadEvents();
              loadStats(saved.event_id);
              loadGalleryPage(0, false, saved.event_id);
            }
          } catch {}
        }, 5000);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to connect folder';
      setCreateError(message);
      setError(message);
    } finally {
      setIsLoadingPreview(false);
    }
  };

  const handleUpdateStrictness = async (delta: number) => {
    if (!config) return;
    const newSim = Math.max(0.1, Math.min(0.9, config.sim_threshold + delta));
    try {
      const res = await updateConfig(Number(newSim.toFixed(2)));
      setConfig(res.config);
    } catch {
      alert('Failed to update settings');
    }
  };

  const handleDeleteEvent = async () => {
    if (!activeEventId) return;
    const msg = `Are you sure you want to delete all photos for event "${currentDbEvent?.name || activeEventId}"?`;

    if (confirm(msg)) {
      try {
        await deleteEvent(activeEventId);
        alert(`Event "${currentDbEvent?.name || activeEventId}" cleared.`);
        setFolderData(null);
        setIngestProgress(null);
        loadStats(activeEventId);
        loadGalleryPage(0, false, activeEventId);
      } catch (e) {
        alert('Failed to delete data: ' + e);
      }
    }
  };

  const handleDeletePhoto = async (fileId: string) => {
    if (confirm('Are you sure you want to delete this photo from this event?')) {
      try {
        await deletePhoto(fileId);
        setPhotos(prev => prev.filter(p => p.drive_file_id !== fileId));
        setGalleryTotal(prev => prev - 1);
        if (selectedPhoto?.drive_file_id === fileId) {
          setSelectedPhoto(null);
        }
        loadStats(activeEventId);
      } catch (e) {
        alert('Failed to delete photo: ' + e);
      }
    }
  };

  // ── Share / Attendee link helper ────────────────────────────────────────────

  const getAttendeeUrl = () => {
    const base = Platform.OS === 'web' ? window.location.origin : (process.env.EXPO_PUBLIC_APP_URL || 'http://localhost:8081');
    return `${base}/attendee${activeEventId ? `?event=${encodeURIComponent(activeEventId)}` : ''}`;
  };

  const handleCopyLink = () => {
    const url = getAttendeeUrl();
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(url);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2500);
    } else {
      alert(`Direct Attendee Link:\n\n${url}`);
    }
  };

  const handleOpenAttendeeInNewTab = () => {
    const url = getAttendeeUrl();
    if (Platform.OS === 'web') {
      window.open(url, '_blank');
    } else {
      Linking.openURL(url);
    }
  };

  // ── Test Event Face Recognition ─────────────────────────────────────────────

  const openTestModal = () => {
    setTestError('');
    setTestMatches([]);
    setTestFacesCount(0);
    setTestImageUri(null);
    setTestModalVisible(true);
  };

  const triggerTestFilePicker = () => {
    if (Platform.OS !== 'web') return;
    if (!testFileInputRef.current) {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/jpeg,image/png,image/webp';
      input.style.display = 'none';
      input.addEventListener('change', (e: Event) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (file) {
          const url = URL.createObjectURL(file);
          setTestImageUri(url);
          runTestSearch(url);
        }
      });
      document.body.appendChild(input);
      testFileInputRef.current = input;
    }
    testFileInputRef.current.value = '';
    testFileInputRef.current.click();
  };

  const runTestSearch = async (uri: string) => {
    if (!uri || !activeEventId) return;
    setIsTesting(true);
    setTestError('');
    setTestMatches([]);
    setTestFacesCount(0);

    try {
      const res = await identifyFace(uri, activeEventId);
      setTestFacesCount(res.faces_detected);
      setTestMatches(res.matches);
    } catch (err: unknown) {
      setTestError(err instanceof Error ? err.message : 'Test search failed');
    } finally {
      setIsTesting(false);
    }
  };

  const subfolderEntries = folderData ? Object.entries(folderData.subfolders) : [];
  const progressPct =
    ingestProgress && ingestProgress.total_images > 0
      ? Math.round((ingestProgress.processed / ingestProgress.total_images) * 100)
      : 0;
  const hasMorePhotos = photos.length < galleryTotal;

  // Active event object from database
  const currentDbEvent = savedEvents.find(e => e.event_id === activeEventId);

  // ── Gallery item ──────────────────────────────────────────────────────────

  const renderPhoto = ({ item }: ListRenderItemInfo<PhotoItem>) => (
    <Pressable style={styles.photoCell} onPress={() => setSelectedPhoto(item)}>
      <Image
        source={{ uri: photoProxyUrl(item.drive_file_id) }}
        style={styles.photoThumb}
        resizeMode="cover"
      />
      <View style={styles.photoOverlay}>
        <Text style={styles.photoLabel} numberOfLines={1}>
          {item.filename}
        </Text>
      </View>
      <Pressable
        style={styles.photoDeleteBtn}
        onPress={(e) => {
          e.stopPropagation();
          handleDeletePhoto(item.drive_file_id);
        }}
      >
        <Ionicons name="trash-outline" size={15} color="#fff" />
      </Pressable>
    </Pressable>
  );

  return (
    <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
      
      {/* ── 1. Photographer Profile Header ─────────────────────────────── */}
      <View style={styles.profileHeader}>
        <View style={styles.avatarCircle}>
          <Text style={styles.avatarText}>
            {(user?.name || 'P').charAt(0).toUpperCase()}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.profileName}>{user?.name || 'Photographer'}</Text>
          <Text style={styles.profileEmail}>{user?.email || 'Organizer Dashboard'}</Text>
        </View>
        <Pressable onPress={() => logout()} style={styles.logoutButton}>
          <Ionicons name="log-out-outline" size={18} color={COLORS.textMuted} />
          <Text style={styles.logoutText}>Sign Out</Text>
        </Pressable>
      </View>

      {/* ── 2. "Your Events" Bar or Empty State ────────────────────────── */}
      {savedEvents.length === 0 ? (
        <View style={styles.emptyWelcomeCard}>
          <View style={styles.emptyWelcomeIcon}>
            <Ionicons name="camera-outline" size={36} color={COLORS.accent} />
          </View>
          <Text style={styles.emptyWelcomeTitle}>Welcome to FindPhotos, {user?.name}!</Text>
          <Text style={styles.emptyWelcomeSubtitle}>
            You haven't created any events yet. Create your first event to connect Google Drive and let attendees find their photos with face recognition.
          </Text>
          <Pressable onPress={openCreateSheet} style={styles.createFirstEventBtn}>
            <Ionicons name="add-circle" size={20} color="#fff" />
            <Text style={styles.createFirstEventBtnText}>Create Your First Event</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.eventsCard}>
          <View style={styles.eventsCardHeader}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Ionicons name="calendar-outline" size={20} color={COLORS.accent} />
              <Text style={styles.sectionTitle}>Your Events</Text>
              <View style={styles.eventCountBadge}>
                <Text style={styles.eventCountBadgeText}>{savedEvents.length}</Text>
              </View>
            </View>
            <Pressable onPress={openCreateSheet} style={styles.newEventPill}>
              <Ionicons name="add" size={16} color="#fff" />
              <Text style={styles.newEventPillText}>Create Event</Text>
            </Pressable>
          </View>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsScroll}>
            {savedEvents.map(evt => {
              const isActive = activeEventId === evt.event_id;
              return (
                <Pressable
                  key={evt.id}
                  onPress={() => handleSelectEvent(evt.event_id)}
                  style={[styles.eventChip, isActive && styles.eventChipActive]}
                >
                  {isActive && <Ionicons name="checkmark-circle" size={14} color="#fff" />}
                  <Text style={[styles.eventChipText, isActive && styles.eventChipTextActive]}>
                    {evt.name}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* ── 3. Active Event Details, Test Event & Live QR Scanner Card ─── */}
      {activeEventId && currentDbEvent ? (
        <View style={styles.qrCard}>
          <View style={styles.qrHeader}>
            <View style={{ flex: 1 }}>
              <Text style={styles.qrEventTitle}>{currentDbEvent.name}</Text>
              <Text style={styles.qrEventCode}>Event Code: <Text style={styles.boldText}>{currentDbEvent.event_id}</Text></Text>
            </View>
            <View style={styles.liveBadge}>
              <View style={styles.liveDot} />
              <Text style={styles.liveBadgeText}>Live & Ready</Text>
            </View>
          </View>

          {/* Action Buttons: Test Event & Copy Link */}
          <View style={styles.twoActionRow}>
            <Pressable onPress={openTestModal} style={styles.testEventPrimaryBtn}>
              <Ionicons name="flask" size={18} color="#fff" />
              <Text style={styles.testEventPrimaryBtnText}>Test Event</Text>
            </Pressable>

            <Pressable onPress={handleCopyLink} style={styles.shareDetailsBtn}>
              <Ionicons name={copiedLink ? 'checkmark' : 'copy-outline'} size={18} color={COLORS.accent} />
              <Text style={styles.shareDetailsBtnText}>{copiedLink ? 'Link Copied!' : 'Copy Guest Link'}</Text>
            </Pressable>
          </View>

          {/* QR Code Presentation */}
          <View style={styles.qrWrapper}>
            <View style={styles.qrContainer}>
              <QRCode
                value={getAttendeeUrl()}
                size={160}
                backgroundColor="#ffffff"
                color="#000000"
              />
            </View>
            <Text style={styles.qrInstruction}>
              Guests scan this QR code or click the link to directly find and download their photos without needing to login or enter passwords.
            </Text>

            <Pressable onPress={handleOpenAttendeeInNewTab} style={styles.testGuestViewBtn}>
              <Ionicons name="open-outline" size={15} color={COLORS.accent} />
              <Text style={styles.testGuestViewBtnText}>Open Attendee View in New Tab</Text>
            </Pressable>
          </View>

          {/* Danger zone: clear photos */}
          <Pressable onPress={handleDeleteEvent} style={styles.deleteEventBtn}>
            <Ionicons name="trash-outline" size={15} color={COLORS.error} />
            <Text style={styles.deleteEventBtnText}>Wipe Photos for this Event</Text>
          </Pressable>
        </View>
      ) : null}

      {/* ── 4. Stats Banner (Scanned for this event only) ─────────────── */}
      {activeEventId && stats && stats.total_vectors > 0 ? (
        <View style={styles.statsBanner}>
          <Ionicons color={COLORS.success} name="shield-checkmark" size={20} />
          <Text style={styles.statsText}>
            <Text style={styles.statsNum}>{stats.total_vectors.toLocaleString()}</Text> face vectors indexed across{' '}
            <Text style={styles.statsNum}>{galleryTotal}</Text> photos in this event.
          </Text>
        </View>
      ) : null}

      {/* ── 5. Ingestion Progress (if running) ─────────────────────────── */}
      {isIngesting && ingestProgress ? (
        <View style={styles.treeCard}>
          <View style={styles.progressHeader}>
            <ActivityIndicator color={COLORS.accent} size="small" />
            <Text style={styles.progressText}>
              Indexing Faces… {ingestProgress.processed}/{ingestProgress.total_images} ({progressPct}%)
            </Text>
          </View>
          <View style={styles.progressBarBg}>
            <View style={[styles.progressBarFill, { width: `${progressPct}%` }]} />
          </View>
          <Text style={styles.progressDetail}>
            {ingestProgress.faces_found} faces detected so far
          </Text>
        </View>
      ) : null}

      {/* ── 6. Photo Gallery (strictly this event's photos) ────────────── */}
      {activeEventId ? (
        <View style={styles.gallerySection}>
          <View style={styles.galleryHeader}>
            <View>
              <Text style={styles.galleryTitle}>Event Photos</Text>
              <Text style={styles.gallerySubtitle}>
                {galleryTotal} photos indexed for {currentDbEvent?.name || activeEventId}
              </Text>
            </View>
            {photos.length > 0 && (
              <Pressable onPress={() => loadGalleryPage(0, false, activeEventId)} style={styles.refreshBtn}>
                <Ionicons name="refresh-outline" size={16} color={COLORS.textMuted} />
              </Pressable>
            )}
          </View>

          {photos.length > 0 ? (
            <>
              <FlatList
                data={photos}
                keyExtractor={item => item.drive_file_id}
                numColumns={GALLERY_COLS}
                renderItem={renderPhoto}
                scrollEnabled={false}
                columnWrapperStyle={styles.galleryRow}
              />

              {hasMorePhotos && (
                <Pressable
                  disabled={loadingGallery}
                  onPress={() => loadGalleryPage(galleryPage + 1, true, activeEventId)}
                  style={[styles.loadMoreButton, loadingGallery && { opacity: 0.6 }]}
                >
                  {loadingGallery ? (
                    <ActivityIndicator color={COLORS.text} size="small" />
                  ) : (
                    <Text style={styles.loadMoreText}>
                      Load more ({galleryTotal - photos.length} remaining)
                    </Text>
                  )}
                </Pressable>
              )}
            </>
          ) : loadingGallery ? (
            <View style={styles.loadingCard}>
              <ActivityIndicator color={COLORS.accent} size="small" />
              <Text style={styles.loadingText}>Loading event photos…</Text>
            </View>
          ) : (
            <View style={styles.emptyState}>
              <Ionicons name="images-outline" size={40} color={COLORS.textMuted} />
              <Text style={styles.emptyTitle}>No photos indexed yet</Text>
              <Text style={styles.emptyText}>
                Photos will appear here as soon as Drive face indexing completes.
              </Text>
            </View>
          )}
        </View>
      ) : null}

      {/* ── 7. Create Event Modal ──────────────────────────────────────── */}
      <Modal animationType="fade" onRequestClose={closeCreateSheet} transparent visible={sheetVisible}>
        <Pressable onPress={closeCreateSheet} style={styles.backdrop}>
          <Pressable onPress={preventClose} style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Create New Event</Text>
              <Pressable onPress={closeCreateSheet} style={{ padding: 4 }}>
                <Ionicons name="close" size={22} color={COLORS.textMuted} />
              </Pressable>
            </View>

            <Text style={styles.sheetSubtitle}>
              Give your event a name and paste the Google Drive link. The system will auto-generate the event QR code for guests.
            </Text>

            {createError ? (
              <View style={styles.errorBanner}>
                <Ionicons name="alert-circle" size={16} color={COLORS.error} />
                <Text style={styles.errorBannerText}>{createError}</Text>
              </View>
            ) : null}

            <Text style={styles.inputLabel}>Event Name</Text>
            <TextInput
              onChangeText={setEventNameInput}
              placeholder="e.g. Priya & Rohit Wedding"
              placeholderTextColor={COLORS.textMuted}
              style={styles.input}
              value={eventNameInput}
            />

            <Text style={styles.inputLabel}>Google Drive Folder Link</Text>
            <TextInput
              autoCapitalize="none"
              onChangeText={setFolderInput}
              placeholder="https://drive.google.com/drive/folders/..."
              placeholderTextColor={COLORS.textMuted}
              style={styles.input}
              value={folderInput}
            />

            <Pressable
              disabled={isLoadingPreview}
              onPress={onConnectAndCreate}
              style={[styles.connectButton, isLoadingPreview && { opacity: 0.6 }]}
            >
              {isLoadingPreview ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.connectButtonText}>Create Event & Sync Drive</Text>
              )}
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ── 8. Test Event Modal (Photographer test face search) ────────── */}
      <Modal
        animationType="fade"
        onRequestClose={() => setTestModalVisible(false)}
        transparent
        visible={testModalVisible}
      >
        <Pressable onPress={() => setTestModalVisible(false)} style={styles.backdrop}>
          <Pressable onPress={preventClose} style={[styles.sheet, { maxHeight: '90%' }]}>
            <View style={styles.sheetHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="flask" size={20} color={COLORS.accent} />
                <Text style={styles.sheetTitle}>Test Event Face Search</Text>
              </View>
              <Pressable onPress={() => setTestModalVisible(false)} style={{ padding: 4 }}>
                <Ionicons name="close" size={22} color={COLORS.textMuted} />
              </Pressable>
            </View>

            <Text style={styles.sheetSubtitle}>
              Testing for: <Text style={{ color: COLORS.text, fontWeight: '700' }}>{currentDbEvent?.name}</Text>.
              Upload a test selfie to verify face matching works accurately before sharing with attendees.
            </Text>

            <Pressable onPress={triggerTestFilePicker} style={styles.testUploadBtn}>
              <Ionicons name="cloud-upload" size={22} color="#fff" />
              <Text style={styles.testUploadBtnText}>Upload Test Face Photo</Text>
            </Pressable>

            {isTesting && (
              <View style={styles.loadingCard}>
                <ActivityIndicator color={COLORS.accent} size="small" />
                <Text style={styles.loadingText}>Searching face vectors in this event…</Text>
              </View>
            )}

            {testError ? (
              <View style={styles.errorBanner}>
                <Ionicons name="alert-circle" size={16} color={COLORS.error} />
                <Text style={styles.errorBannerText}>{testError}</Text>
              </View>
            ) : null}

            {testMatches.length > 0 ? (
              <View style={{ gap: 8, marginTop: 8 }}>
                <Text style={styles.testResultHeading}>
                  ✅ Found {testMatches.length} matching photos! Face recognition is working properly.
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
                  {testMatches.map(m => (
                    <View key={m.drive_file_id} style={styles.testThumbCard}>
                      <Image
                        source={{ uri: photoProxyUrl(m.drive_file_id) }}
                        style={styles.testThumbImage}
                        resizeMode="cover"
                      />
                      <Text style={styles.testScoreBadge}>{Math.round(m.score * 100)}% match</Text>
                    </View>
                  ))}
                </ScrollView>
              </View>
            ) : !isTesting && testFacesCount === 0 && testImageUri ? (
              <Text style={[styles.sheetSubtitle, { textAlign: 'center', color: COLORS.error }]}>
                No face detected in test photo. Try a clearer image.
              </Text>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>

      {/* ── 9. Photo Full-Screen Viewer Modal ────────────────────────── */}
      <Modal
        animationType="fade"
        onRequestClose={() => setSelectedPhoto(null)}
        transparent
        visible={!!selectedPhoto}
      >
        <View style={styles.viewerBackdrop}>
          <View style={styles.viewerHeader}>
            <Text style={styles.viewerTitle} numberOfLines={1}>
              {selectedPhoto?.filename}
            </Text>
            <Pressable onPress={() => setSelectedPhoto(null)} style={styles.viewerCloseBtn}>
              <Ionicons name="close" size={26} color="#fff" />
            </Pressable>
          </View>

          {selectedPhoto && (
            <Image
              source={{ uri: photoProxyUrl(selectedPhoto.drive_file_id) }}
              style={styles.viewerImage}
              resizeMode="contain"
            />
          )}

          <View style={styles.viewerFooter}>
            <Pressable
              onPress={() => selectedPhoto && handleDeletePhoto(selectedPhoto.drive_file_id)}
              style={styles.viewerDeleteBtn}
            >
              <Ionicons name="trash-outline" size={18} color="#fff" />
              <Text style={styles.viewerDeleteText}>Delete from Event</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  content: {
    padding: 18,
    gap: 16,
  },

  // 1. Profile Header
  profileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
  },
  avatarCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '800',
  },
  profileName: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '700',
  },
  profileEmail: {
    color: COLORS.textMuted,
    fontSize: 12,
  },
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: COLORS.surfaceSoft,
  },
  logoutText: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontWeight: '600',
  },

  // Empty Welcome Card (when 0 events)
  emptyWelcomeCard: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 20,
    padding: 28,
    alignItems: 'center',
    textAlign: 'center',
    gap: 12,
  },
  emptyWelcomeIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(108,92,231,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  emptyWelcomeTitle: {
    color: COLORS.text,
    fontSize: 20,
    fontWeight: '800',
    textAlign: 'center',
  },
  emptyWelcomeSubtitle: {
    color: COLORS.textMuted,
    fontSize: 14,
    lineHeight: 22,
    textAlign: 'center',
    maxWidth: 360,
  },
  createFirstEventBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: COLORS.accent,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 14,
    marginTop: 8,
  },
  createFirstEventBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },

  // 2. Events Card
  eventsCard: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    gap: 12,
  },
  eventsCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '700',
  },
  eventCountBadge: {
    backgroundColor: COLORS.surfaceSoft,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12,
  },
  eventCountBadgeText: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontWeight: '700',
  },
  newEventPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: COLORS.accent,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  newEventPillText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  chipsScroll: {
    gap: 8,
    paddingVertical: 4,
  },
  eventChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: COLORS.surfaceSoft,
    borderColor: COLORS.border,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
  },
  eventChipActive: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.accent,
  },
  eventChipText: {
    color: COLORS.textMuted,
    fontSize: 13,
    fontWeight: '600',
  },
  eventChipTextActive: {
    color: '#fff',
    fontWeight: '700',
  },

  // 3. QR Card
  qrCard: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 18,
    padding: 18,
    gap: 14,
  },
  qrHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  qrEventTitle: {
    color: COLORS.text,
    fontSize: 20,
    fontWeight: '800',
  },
  qrEventCode: {
    color: COLORS.textMuted,
    fontSize: 13,
    marginTop: 2,
  },
  boldText: {
    color: COLORS.text,
    fontWeight: '700',
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(76,217,123,0.12)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: COLORS.success,
  },
  liveBadgeText: {
    color: COLORS.success,
    fontSize: 11,
    fontWeight: '700',
  },
  twoActionRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  testEventPrimaryBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: COLORS.accent,
    paddingVertical: 12,
    borderRadius: 12,
  },
  testEventPrimaryBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  shareDetailsBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: COLORS.surfaceSoft,
    borderColor: COLORS.accent,
    borderWidth: 1,
    paddingVertical: 12,
    borderRadius: 12,
  },
  shareDetailsBtnText: {
    color: COLORS.accent,
    fontSize: 13,
    fontWeight: '700',
  },
  qrWrapper: {
    alignItems: 'center',
    paddingVertical: 8,
    gap: 10,
  },
  qrContainer: {
    padding: 14,
    backgroundColor: '#fff',
    borderRadius: 16,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 10,
    elevation: 4,
  },
  qrInstruction: {
    color: COLORS.textMuted,
    fontSize: 12,
    textAlign: 'center',
    maxWidth: 300,
    lineHeight: 18,
  },
  testGuestViewBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: COLORS.surfaceSoft,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    marginTop: 4,
  },
  testGuestViewBtnText: {
    color: COLORS.accent,
    fontSize: 12,
    fontWeight: '700',
  },
  deleteEventBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
  },
  deleteEventBtnText: {
    color: COLORS.error,
    fontSize: 12,
    fontWeight: '600',
  },

  // 4. Stats Banner
  statsBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(76,217,123,0.08)',
    borderColor: 'rgba(76,217,123,0.25)',
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
  },
  statsText: {
    color: COLORS.textMuted,
    fontSize: 13,
    flex: 1,
  },
  statsNum: {
    color: COLORS.success,
    fontWeight: '700',
  },

  // 5. Ingest Progress
  treeCard: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    gap: 10,
  },
  progressHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  progressText: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '600',
  },
  progressBarBg: {
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.surfaceSoft,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: COLORS.accent,
  },
  progressDetail: {
    color: COLORS.textMuted,
    fontSize: 12,
  },

  // 6. Gallery
  gallerySection: {
    gap: 12,
    marginTop: 4,
  },
  galleryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  galleryTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '800',
  },
  gallerySubtitle: {
    color: COLORS.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  refreshBtn: {
    padding: 8,
    borderRadius: 8,
    backgroundColor: COLORS.surfaceSoft,
  },
  galleryRow: {
    gap: 6,
    marginBottom: 6,
  },
  photoCell: {
    flex: 1 / GALLERY_COLS,
    maxWidth: `${100 / GALLERY_COLS}%` as unknown as number,
    aspectRatio: 1,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: COLORS.surface,
    position: 'relative',
  },
  photoThumb: {
    width: '100%',
    height: '100%',
  },
  photoOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.65)',
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  photoLabel: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '500',
  },
  photoDeleteBtn: {
    position: 'absolute',
    top: 6,
    right: 6,
    backgroundColor: 'rgba(0,0,0,0.65)',
    borderRadius: 14,
    padding: 5,
  },
  loadMoreButton: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 12,
    marginTop: 6,
  },
  loadMoreText: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '600',
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 30,
    gap: 8,
  },
  emptyTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '700',
  },
  emptyText: {
    color: COLORS.textMuted,
    fontSize: 13,
    textAlign: 'center',
    maxWidth: 280,
  },
  loadingCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
  },
  loadingText: {
    color: COLORS.textMuted,
    fontSize: 14,
  },

  // 7. Create Modal
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(8,9,18,0.75)',
    padding: 16,
  },
  sheet: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 20,
    padding: 20,
    gap: 10,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sheetTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '800',
  },
  sheetSubtitle: {
    color: COLORS.textMuted,
    fontSize: 13,
    marginBottom: 4,
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(255,107,129,0.1)',
    borderRadius: 10,
    padding: 10,
  },
  errorBannerText: {
    color: COLORS.error,
    fontSize: 12,
    fontWeight: '600',
    flex: 1,
  },
  inputLabel: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '700',
    marginTop: 4,
  },
  input: {
    backgroundColor: COLORS.surfaceSoft,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 12,
    color: COLORS.text,
    fontSize: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  connectButton: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.accent,
    borderRadius: 12,
    minHeight: 46,
    marginTop: 10,
  },
  connectButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },

  // 8. Test Modal
  testUploadBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: COLORS.accent,
    paddingVertical: 12,
    borderRadius: 12,
    marginTop: 6,
  },
  testUploadBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  testResultHeading: {
    color: COLORS.success,
    fontSize: 13,
    fontWeight: '700',
  },
  testThumbCard: {
    width: 100,
    height: 100,
    borderRadius: 10,
    overflow: 'hidden',
    position: 'relative',
    backgroundColor: COLORS.surfaceSoft,
  },
  testThumbImage: {
    width: '100%',
    height: '100%',
  },
  testScoreBadge: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    backgroundColor: 'rgba(0,0,0,0.7)',
    color: '#fff',
    fontSize: 9,
    fontWeight: '700',
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderRadius: 4,
  },

  // 9. Full Viewer Modal
  viewerBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    justifyContent: 'space-between',
    padding: 16,
  },
  viewerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 16,
  },
  viewerTitle: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
    marginRight: 10,
  },
  viewerCloseBtn: {
    padding: 6,
  },
  viewerImage: {
    width: '100%',
    height: '75%',
  },
  viewerFooter: {
    paddingBottom: 20,
    alignItems: 'center',
  },
  viewerDeleteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: COLORS.error,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 12,
  },
  viewerDeleteText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
});
