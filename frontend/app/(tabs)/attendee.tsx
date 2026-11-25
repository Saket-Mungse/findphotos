import { useRef, useState, useEffect } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  TextInput,
  useWindowDimensions,
} from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import { COLORS } from '@/constants/theme';
import { identifyFace, photoProxyUrl, downloadPhotosZip, apiGetEventInfo, type PhotoMatch } from '@/lib/api';

export default function AttendeeScreen() {
  const { event } = useLocalSearchParams<{ event?: string }>();
  const [manualEventId, setManualEventId] = useState('');
  const [eventName, setEventName] = useState('');
  const [tempCodeInput, setTempCodeInput] = useState('');

  // Active event ID is either from QR/URL query param or manual input
  const activeEventId = event || manualEventId;

  // Camera & Upload state
  const cameraRef = useRef<CameraView | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const { width } = useWindowDimensions();

  // QR Scanner modal state
  const [qrScannerVisible, setQrScannerVisible] = useState(false);

  // Selfie capture state
  const [cameraVisible, setCameraVisible] = useState(false);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [capturedUri, setCapturedUri] = useState<string | null>(null);
  const [showResults, setShowResults] = useState(false);
  const [cameraError, setCameraError] = useState('');

  // API Face Search state
  const [isSearching, setIsSearching] = useState(false);
  const [matches, setMatches] = useState<PhotoMatch[]>([]);
  const [facesDetected, setFacesDetected] = useState(0);
  const [searchError, setSearchError] = useState('');

  // Viewer state
  const [selectedPhoto, setSelectedPhoto] = useState<PhotoMatch | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);

  // Web file picker ref
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const itemSize = Math.min(180, Math.max(90, (width - 64) / 3));

  // Automatically fetch event info whenever activeEventId changes
  useEffect(() => {
    if (activeEventId) {
      apiGetEventInfo(activeEventId).then(info => {
        setEventName(info.name);
      }).catch(() => {
        setEventName(activeEventId);
      });
    } else {
      setEventName('');
    }
  }, [activeEventId]);

  // ── QR Scanner Handler ─────────────────────────────────────────────────────

  const openQrScanner = async () => {
    if (Platform.OS === 'web') {
      alert('To scan with a mobile phone, open your phone camera and point it at the event QR code.');
      return;
    }
    const currentPermission = permission?.granted ? permission : await requestPermission();
    if (!currentPermission.granted) {
      alert('Camera permission is required to scan the event QR code.');
      return;
    }
    setQrScannerVisible(true);
  };

  const handleBarcodeScanned = ({ data }: { data: string }) => {
    let extractedId = data.trim();
    if (extractedId.includes('event=')) {
      try {
        const match = extractedId.match(/event=([^&]+)/);
        if (match) extractedId = decodeURIComponent(match[1]);
      } catch {}
    }
    setQrScannerVisible(false);
    if (extractedId) {
      setManualEventId(extractedId);
      resetSearch();
    }
  };

  // ── Camera / File Upload for Selfie ────────────────────────────────────────

  const openCamera = async () => {
    setCameraError('');

    if (Platform.OS === 'web') {
      triggerFilePicker();
      return;
    }

    const currentPermission = permission?.granted ? permission : await requestPermission();
    if (!currentPermission.granted) {
      setCameraError('Camera permission is required to capture a selfie.');
      return;
    }

    setCameraVisible(true);
  };

  const triggerFilePicker = () => {
    if (Platform.OS !== 'web') return;

    if (!fileInputRef.current) {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/jpeg,image/png,image/webp';
      input.style.display = 'none';
      input.addEventListener('change', handleFileSelected);
      document.body.appendChild(input);
      fileInputRef.current = input;
    }
    fileInputRef.current.value = '';
    fileInputRef.current.click();
  };

  const handleFileSelected = (event: Event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const url = URL.createObjectURL(file);
    setCapturedUri(url);
    setPreviewVisible(true);
  };

  const capturePhoto = async () => {
    if (!cameraRef.current) return;

    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.6,
        skipProcessing: true,
      });

      if (photo?.uri) {
        setCapturedUri(photo.uri);
        setCameraVisible(false);
        setPreviewVisible(true);
      }
    } catch {
      setCameraError('Unable to capture photo. Please try again.');
    }
  };

  const retake = async () => {
    setPreviewVisible(false);
    setSearchError('');
    await openCamera();
  };

  // ── Face Search ───────────────────────────────────────────────────────────

  const runSearch = async () => {
    if (!capturedUri || !activeEventId) return;

    setCameraVisible(false);
    setPreviewVisible(false);
    setIsSearching(true);
    setSearchError('');
    setFacesDetected(0);
    setMatches([]);
    setShowResults(true);

    try {
      const data = await identifyFace(capturedUri, activeEventId);
      setFacesDetected(data.faces_detected);
      setMatches(data.matches);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to identify face';
      setSearchError(message);
    } finally {
      setIsSearching(false);
    }
  };

  const resetSearch = () => {
    setShowResults(false);
    setMatches([]);
    setSearchError('');
    setCapturedUri(null);
    setFacesDetected(0);
  };

  // ── Download Helpers ──────────────────────────────────────────────────────

  const downloadPhoto = async (photo: PhotoMatch) => {
    setIsDownloading(true);
    try {
      const url = photoProxyUrl(photo.drive_file_id);
      const rawFilename = photo.filename || `photo_${photo.drive_file_id}.jpg`;
      const safeFilename = rawFilename.replace(/[^a-zA-Z0-9.\-_]/g, '_');

      if (Platform.OS === 'web') {
        const res = await fetch(`${url}?download=1`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`Server returned HTTP ${res.status}`);
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = safeFilename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          try {
            document.body.removeChild(a);
            URL.revokeObjectURL(blobUrl);
          } catch (_) {}
        }, 2000);
      } else {
        const fileUri = FileSystem.documentDirectory + safeFilename;
        const downloaded = await FileSystem.downloadAsync(url, fileUri);
        if (downloaded.status !== 200) {
          throw new Error(`Server returned HTTP ${downloaded.status}`);
        }
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(downloaded.uri);
        } else {
          alert('Sharing is not available on this device');
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(`Failed to download photo: ${msg}`);
    } finally {
      setIsDownloading(false);
    }
  };

  const handleDownloadZip = async () => {
    if (matches.length === 0 || !activeEventId) return;
    setIsDownloading(true);
    try {
      const blob = await downloadPhotosZip(
        matches.map(m => ({ drive_file_id: m.drive_file_id, filename: m.filename }))
      );

      if (Platform.OS === 'web') {
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = `${activeEventId}_photos.zip`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          try {
            document.body.removeChild(a);
            URL.revokeObjectURL(blobUrl);
          } catch (_) {}
        }, 2000);
      } else {
        const fileUri = FileSystem.documentDirectory + `${activeEventId}_photos.zip`;
        const reader = new FileReader();
        reader.onloadend = async () => {
          const base64data = (reader.result as string).split(',')[1];
          await FileSystem.writeAsStringAsync(fileUri, base64data, { encoding: FileSystem.EncodingType.Base64 });
          if (await Sharing.isAvailableAsync()) {
            await Sharing.shareAsync(fileUri);
          } else {
            alert('Sharing is not available on this device');
          }
        };
        reader.readAsDataURL(blob);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(`Failed to download zip: ${msg}`);
    } finally {
      setIsDownloading(false);
    }
  };

  const renderMatchItem = ({ item }: { item: PhotoMatch }) => (
    <Pressable
      onPress={() => setSelectedPhoto(item)}
      style={[styles.photoCard, { width: itemSize, height: itemSize }]}
    >
      <Image
        source={{ uri: photoProxyUrl(item.drive_file_id) }}
        style={styles.photoImage}
        resizeMode="cover"
      />
      <View style={styles.scoreBadge}>
        <Text style={styles.scoreText}>{Math.round(item.score * 100)}%</Text>
      </View>
    </Pressable>
  );

  // ── 1. If No Event Selected (Attendee opened manually without scan/link) ───

  if (!activeEventId) {
    return (
      <View style={[styles.screen, styles.centerScreen]}>
        <View style={styles.promptCard}>
          <View style={styles.promptIcon}>
            <Ionicons name="qr-code-outline" size={32} color={COLORS.accent} />
          </View>
          <Text style={styles.promptTitle}>Join Event Album</Text>
          <Text style={styles.promptText}>
            Scan the event QR code or enter the event code from the organizer to find your photos.
          </Text>

          {/* Option A: In-app QR Scanner */}
          {Platform.OS !== 'web' && (
            <Pressable onPress={openQrScanner} style={styles.scanQrBtn}>
              <Ionicons name="scan-outline" size={20} color="#fff" />
              <Text style={styles.scanQrBtnText}>Scan Event QR Code</Text>
            </Pressable>
          )}

          {/* Option B: Manual Event Code Entry */}
          <View style={styles.fieldBlock}>
            <Text style={styles.fieldLabel}>Event Code</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. rohit_wedding_8f21"
              placeholderTextColor={COLORS.textMuted}
              value={tempCodeInput}
              onChangeText={setTempCodeInput}
              autoCapitalize="none"
            />
          </View>

          <Pressable
            disabled={!tempCodeInput.trim()}
            style={[styles.actionButton, !tempCodeInput.trim() && { opacity: 0.5 }]}
            onPress={() => {
              if (tempCodeInput.trim()) {
                setManualEventId(tempCodeInput.trim());
              }
            }}
          >
            <Text style={styles.actionButtonText}>Proceed to Event</Text>
          </Pressable>
        </View>

        {/* QR Scanner Modal (for mobile native) */}
        <Modal
          animationType="slide"
          onRequestClose={() => setQrScannerVisible(false)}
          visible={qrScannerVisible}
        >
          <View style={styles.cameraScreen}>
            <CameraView
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={handleBarcodeScanned}
              style={StyleSheet.absoluteFill}
            />
            <View style={styles.qrScanOverlay}>
              <View style={styles.qrTargetBox} />
              <Text style={styles.qrTargetHint}>Point camera at the event QR code</Text>
            </View>
            <Pressable
              onPress={() => setQrScannerVisible(false)}
              style={styles.closeScannerBtn}
            >
              <Ionicons name="close" size={26} color="#fff" />
            </Pressable>
          </View>
        </Modal>
      </View>
    );
  }

  // ── 2. Direct Attendee Event Screen (No Login, No Password Required!) ──────

  return (
    <View style={styles.screen}>
      
      {/* Top Event Header */}
      <View style={styles.eventTopHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.eventTopName}>{eventName || activeEventId}</Text>
          <Text style={styles.eventTopId}>Code: {activeEventId}</Text>
        </View>
        <Pressable onPress={() => { setManualEventId(''); resetSearch(); }} style={styles.switchEventBtn}>
          <Ionicons name="refresh-outline" size={15} color={COLORS.textMuted} />
          <Text style={styles.switchEventBtnText}>Change Event</Text>
        </Pressable>
      </View>

      {!showResults ? (
        /* Direct Selfie Upload Screen */
        <View style={styles.centerContainer}>
          <Text style={styles.title}>Find Your Photos</Text>
          <Text style={styles.subtitle}>
            Upload a selfie, and our AI will instantly find all photos from <Text style={{ color: COLORS.text, fontWeight: '700' }}>{eventName || activeEventId}</Text> that you appear in.
          </Text>

          <Pressable onPress={openCamera} style={styles.captureButton}>
            <Ionicons
              color="#fff"
              name={Platform.OS === 'web' ? 'cloud-upload' : 'camera'}
              size={38}
            />
            <Text style={styles.captureText}>
              {Platform.OS === 'web' ? 'Upload Selfie' : 'Take Selfie'}
            </Text>
          </Pressable>

          <Text style={styles.captureHint}>
            Upload a clear face photo • Your photos will be retrieved in seconds
          </Text>
          {cameraError ? <Text style={styles.errorText}>{cameraError}</Text> : null}
        </View>
      ) : (
        /* Results View */
        <View style={styles.resultsContainer}>
          <View style={styles.resultsHeader}>
            <View style={{ flex: 1 }}>
              <Text style={styles.resultsTitle}>Found {matches.length} Photos of You</Text>
              <Text style={styles.resultsSubtitle}>
                {facesDetected > 1 ? 'Multiple faces detected in selfie. ' : ''}
                Matched photos sorted by similarity.
              </Text>
            </View>
            <View style={styles.headerActions}>
              {matches.length > 0 && (
                <Pressable
                  onPress={handleDownloadZip}
                  disabled={isDownloading}
                  style={styles.zipButton}
                >
                  {isDownloading ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <Ionicons color="#fff" name="download" size={16} />
                  )}
                  <Text style={styles.zipButtonText}>Download All (ZIP)</Text>
                </Pressable>
              )}
              <Pressable onPress={resetSearch} style={styles.resetButton}>
                <Ionicons color={COLORS.text} name="close" size={20} />
              </Pressable>
            </View>
          </View>

          {isSearching ? (
            <View style={styles.searchingContainer}>
              <ActivityIndicator color={COLORS.accent} size="large" />
              <Text style={styles.searchingText}>Finding your photos…</Text>
            </View>
          ) : searchError ? (
            <View style={styles.errorContainer}>
              <Ionicons color={COLORS.error} name="alert-circle-outline" size={36} />
              <Text style={styles.errorTitle}>Search Failed</Text>
              <Text style={styles.errorDetail}>{searchError}</Text>
              <Pressable onPress={openCamera} style={styles.retryButton}>
                <Text style={styles.retryText}>Try Again</Text>
              </Pressable>
            </View>
          ) : matches.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Ionicons color={COLORS.textMuted} name="images-outline" size={48} />
              <Text style={styles.emptyTitle}>No Matching Photos Found</Text>
              <Text style={styles.emptyText}>
                {facesDetected === 0
                  ? 'No face was detected in your selfie. Please try a clearer photo.'
                  : 'Your face was detected, but no matching photos were found in this event.'}
              </Text>
              <Pressable onPress={openCamera} style={styles.retryButton}>
                <Text style={styles.retryText}>Try Another Photo</Text>
              </Pressable>
            </View>
          ) : (
            <FlatList
              columnWrapperStyle={styles.gridRow}
              contentContainerStyle={styles.gridContent}
              data={matches}
              keyExtractor={(item) => item.drive_file_id}
              numColumns={3}
              renderItem={renderMatchItem}
              showsVerticalScrollIndicator={false}
            />
          )}
        </View>
      )}

      {/* Native Camera Modal */}
      <Modal animationType="slide" onRequestClose={() => setCameraVisible(false)} visible={cameraVisible}>
        <View style={styles.cameraScreen}>
          <CameraView facing="front" ref={cameraRef} style={StyleSheet.absoluteFill} />
          <View style={styles.cameraFooter}>
            <Pressable onPress={() => setCameraVisible(false)} style={styles.cameraSecondaryAction}>
              <Ionicons color="#fff" name="close" size={20} />
            </Pressable>
            <Pressable onPress={capturePhoto} style={styles.shutterOuter}>
              <View style={styles.shutterInner} />
            </Pressable>
            <View style={styles.cameraSecondarySpacer} />
          </View>
        </View>
      </Modal>

      {/* Preview Modal before Searching */}
      <Modal animationType="fade" onRequestClose={() => setPreviewVisible(false)} transparent visible={previewVisible}>
        <View style={styles.previewBackdrop}>
          <View style={styles.previewCard}>
            <Text style={styles.previewTitle}>Confirm Selfie</Text>
            {capturedUri ? <Image source={{ uri: capturedUri }} style={styles.previewImage} /> : null}

            <View style={styles.previewActions}>
              <Pressable onPress={retake} style={styles.previewSecondaryButton}>
                <Text style={styles.previewSecondaryText}>Retake</Text>
              </Pressable>
              <Pressable onPress={runSearch} style={styles.previewPrimaryButton}>
                {isSearching ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.previewPrimaryText}>Find My Photos</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Full Photo Viewer Modal */}
      <Modal animationType="fade" onRequestClose={() => setSelectedPhoto(null)} transparent visible={!!selectedPhoto}>
        <View style={styles.viewerBackdrop}>
          <View style={styles.viewerHeader}>
            <Pressable onPress={() => setSelectedPhoto(null)} style={styles.viewerCloseButton}>
              <Ionicons color="#fff" name="close" size={28} />
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
              disabled={isDownloading}
              onPress={() => selectedPhoto && downloadPhoto(selectedPhoto)}
              style={styles.downloadButton}
            >
              {isDownloading ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <>
                  <Ionicons color="#fff" name="download-outline" size={20} />
                  <Text style={styles.downloadButtonText}>Download Photo</Text>
                </>
              )}
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  centerScreen: {
    justifyContent: 'center',
    padding: 20,
  },

  // Gate Card (only if opened with no QR code/link)
  promptCard: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 20,
    padding: 24,
    gap: 14,
    maxWidth: 440,
    width: '100%',
    alignSelf: 'center',
  },
  promptIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(108,92,231,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: 4,
  },
  promptTitle: {
    color: COLORS.text,
    fontSize: 22,
    fontWeight: '800',
    textAlign: 'center',
  },
  promptText: {
    color: COLORS.textMuted,
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
  },
  scanQrBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: COLORS.accent,
    paddingVertical: 14,
    borderRadius: 12,
    marginTop: 4,
  },
  scanQrBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  fieldBlock: {
    gap: 6,
    marginTop: 4,
  },
  fieldLabel: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '600',
  },
  input: {
    backgroundColor: COLORS.surfaceSoft,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 12,
    color: COLORS.text,
    fontSize: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  actionButton: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.surfaceSoft,
    borderColor: COLORS.accent,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    marginTop: 4,
  },
  actionButtonText: {
    color: COLORS.accent,
    fontSize: 15,
    fontWeight: '700',
  },

  // QR Scanner Screen Overlay
  qrScanOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrTargetBox: {
    width: 240,
    height: 240,
    borderWidth: 2,
    borderColor: COLORS.accent,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  qrTargetHint: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    marginTop: 16,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 10,
  },
  closeScannerBtn: {
    position: 'absolute',
    top: 40,
    right: 20,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 20,
    padding: 8,
  },

  // Top Bar on Active Event
  eventTopHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 14,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  eventTopName: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '800',
  },
  eventTopId: {
    color: COLORS.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  switchEventBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: COLORS.surfaceSoft,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
  },
  switchEventBtnText: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontWeight: '600',
  },

  // Center Selfie Prompt
  centerContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 16,
  },
  title: {
    color: COLORS.text,
    fontSize: 26,
    fontWeight: '800',
    textAlign: 'center',
  },
  subtitle: {
    color: COLORS.textMuted,
    fontSize: 14,
    lineHeight: 22,
    textAlign: 'center',
    maxWidth: 400,
  },
  captureButton: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 170,
    height: 170,
    borderRadius: 85,
    backgroundColor: COLORS.accent,
    gap: 10,
    shadowColor: COLORS.accent,
    shadowOpacity: 0.35,
    shadowRadius: 18,
    elevation: 8,
    marginVertical: 10,
  },
  captureText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '800',
  },
  captureHint: {
    color: COLORS.textMuted,
    fontSize: 12,
    textAlign: 'center',
  },
  errorText: {
    color: COLORS.error,
    fontSize: 13,
    textAlign: 'center',
  },

  // Results
  resultsContainer: {
    flex: 1,
    paddingTop: 16,
    paddingHorizontal: 16,
  },
  resultsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  resultsTitle: {
    color: COLORS.text,
    fontSize: 22,
    fontWeight: '800',
  },
  resultsSubtitle: {
    color: COLORS.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  headerActions: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  zipButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: COLORS.accent,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
  },
  zipButtonText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  resetButton: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: COLORS.surfaceSoft,
  },
  searchingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  searchingText: {
    color: COLORS.textMuted,
    fontSize: 15,
    fontWeight: '600',
  },
  errorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 24,
  },
  errorTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '700',
  },
  errorDetail: {
    color: COLORS.textMuted,
    fontSize: 13,
    textAlign: 'center',
  },
  retryButton: {
    backgroundColor: COLORS.accent,
    borderRadius: 12,
    paddingHorizontal: 22,
    paddingVertical: 10,
    marginTop: 8,
  },
  retryText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 24,
  },
  emptyTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '700',
  },
  emptyText: {
    color: COLORS.textMuted,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 320,
  },
  gridContent: {
    paddingBottom: 24,
  },
  gridRow: {
    gap: 8,
    marginBottom: 8,
  },
  photoCard: {
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: COLORS.surfaceSoft,
    position: 'relative',
  },
  photoImage: {
    width: '100%',
    height: '100%',
  },
  scoreBadge: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  scoreText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },

  // Native Camera
  cameraScreen: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'flex-end',
  },
  cameraFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 28,
    paddingBottom: 36,
    paddingTop: 16,
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  cameraSecondaryAction: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  cameraSecondarySpacer: {
    width: 42,
  },
  shutterOuter: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 4,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterInner: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#fff',
  },

  // Preview Modal
  previewBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  previewCard: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 20,
    padding: 20,
    width: '100%',
    maxWidth: 380,
    alignItems: 'center',
    gap: 14,
  },
  previewTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '800',
  },
  previewImage: {
    width: 220,
    height: 220,
    borderRadius: 16,
  },
  previewActions: {
    flexDirection: 'row',
    gap: 10,
    width: '100%',
  },
  previewSecondaryButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: COLORS.surfaceSoft,
  },
  previewSecondaryText: {
    color: COLORS.textMuted,
    fontSize: 14,
    fontWeight: '600',
  },
  previewPrimaryButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: COLORS.accent,
  },
  previewPrimaryText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },

  // Full Photo Viewer
  viewerBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    justifyContent: 'space-between',
    padding: 16,
  },
  viewerHeader: {
    alignItems: 'flex-end',
    paddingTop: 16,
  },
  viewerCloseButton: {
    padding: 6,
  },
  viewerImage: {
    width: '100%',
    height: '75%',
  },
  viewerFooter: {
    paddingBottom: 24,
    alignItems: 'center',
  },
  downloadButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: COLORS.accent,
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 14,
  },
  downloadButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
});
