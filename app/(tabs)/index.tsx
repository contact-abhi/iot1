import React, { useEffect, useRef, useState } from 'react';

import {
    ActivityIndicator,
    Dimensions,
    SafeAreaView,
    ScrollView,
    StatusBar,
    StyleSheet,
    Text,
    View,
} from 'react-native';

import { LinearGradient } from 'expo-linear-gradient';

import * as Notifications from 'expo-notifications';

import { Ionicons } from '@expo/vector-icons';

import {
    LineChart,
    ProgressChart,
} from 'react-native-chart-kit';

const screenWidth =
  Dimensions.get('window').width;

/* =======================================================
   THINGSPEAK CONFIG
======================================================= */

const CHANNEL_ID = '3371746';

const READ_API_KEY =
  'EWNOKXDC2MMVEUUZ';

const API_URL =
  `https://api.thingspeak.com/channels/${CHANNEL_ID}/feeds.json?results=1&api_key=${READ_API_KEY}`;

/* ESP32 = device activity, not HTTP success. Uses latest feed
   timestamp + ThingSpeak entry identity (new row vs stale repeat). */
const POLL_INTERVAL_MS = 8000;

const ESP32_TS_ONLINE_SEC = 20;

const ESP32_TS_OFFLINE_SEC = 30;

const ESP32_NO_NEW_ENTRY_MS = 28000;

/* =======================================================
   NOTIFICATION CONFIG
======================================================= */

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export default function HomeScreen() {

  /* =======================================================
     STATES
  ======================================================= */

  const [connected, setConnected] =
    useState(false);

  const [sensorActive, setSensorActive] =
    useState(false);

  const [temperature, setTemperature] =
    useState('----');

  const [humidity, setHumidity] =
    useState('----');

  const [status, setStatus] =
    useState('WAITING FOR SENSOR DATA');

  const [lastUpdated, setLastUpdated] =
    useState('--:--');

  const [tempHistory, setTempHistory] =
    useState<number[]>([]);

  const [humHistory, setHumHistory] =
    useState<number[]>([]);

  const [timeLabels, setTimeLabels] =
    useState<string[]>([]);

  const [avgTemp, setAvgTemp] =
    useState(0);

  const [avgHum, setAvgHum] =
    useState(0);

  /* =======================================================
     ALERT FLAGS
  ======================================================= */

  const tempAlertSent =
    useRef(false);

  const lowHumAlertSent =
    useRef(false);

  const highHumAlertSent =
    useRef(false);

  const sensorOfflineSent =
    useRef(false);

  const sensorOnlineSent =
    useRef(false);

  const lastFeedEntryKeyRef =
    useRef<string | null>(null);

  const lastNewEntryWallMsRef =
    useRef<number>(0);

  const esp32StableOnlineRef =
    useRef(false);

  /* =======================================================
     USE EFFECT
  ======================================================= */

  useEffect(() => {

    requestNotificationPermission();

    fetchThingSpeakData();

    const interval =
      setInterval(() => {

        fetchThingSpeakData();

      }, POLL_INTERVAL_MS);

    return () =>
      clearInterval(interval);

  }, []);

  /* =======================================================
     REQUEST NOTIFICATION PERMISSION
  ======================================================= */

  const requestNotificationPermission =
    async () => {

      const existingPermission =
        await Notifications.getPermissionsAsync();

      if (existingPermission.granted) {
        return;
      }

      const permission =
        await Notifications.requestPermissionsAsync();

      if (!permission.granted) {

        alert(
          'Notifications are disabled.'
        );
      }
    };

  /* =======================================================
     SEND NOTIFICATION
  ======================================================= */

  const sendNotification = async (
    title: string,
    body: string
  ) => {

    try {

      await Notifications.scheduleNotificationAsync({
        content: {
          title,
          body,
          sound: true,
        },

        trigger: null as any,
      });

    } catch (error) {

      console.log(
        'Notification Error:',
        error
      );
    }
  };

  /* =======================================================
     FETCH DATA
  ======================================================= */

  const fetchThingSpeakData =
    async () => {

      try {

        const response =
          await fetch(API_URL);

        if (!response.ok) {

          esp32StableOnlineRef.current = false;

          lastFeedEntryKeyRef.current = null;

          setConnected(false);
          setSensorActive(false);
          setStatus('THINGSPEAK DISCONNECTED');

          return;
        }

        const data =
          await response.json();

        if (
          data &&
          data.feeds &&
          data.feeds.length > 0
        ) {

          const latest =
            data.feeds[
              data.feeds.length - 1
            ];

          const temp =
            latest.field1
              ?.toString()
              .trim();

          const hum =
            latest.field2
              ?.toString()
              .trim();

          const createdAt =
            new Date(
              latest.created_at
            );

          const now = new Date();

          const diffSeconds =
            (now.getTime() -
              createdAt.getTime()) /
            1000;

          const sampleAgeSec =
            Math.max(0, diffSeconds);

          const hasFields =
            !!temp &&
            !!hum &&
            temp !== 'null' &&
            hum !== 'null';

          const tempNum = hasFields
            ? parseFloat(temp)
            : NaN;

          const humNum = hasFields
            ? parseFloat(hum)
            : NaN;

          const numsOk =
            hasFields &&
            !isNaN(tempNum) &&
            !isNaN(humNum);

          const rawEntryId =
            latest.entry_id;

          const entryKey =
            rawEntryId !== undefined &&
            rawEntryId !== null &&
            `${rawEntryId}`.trim() !== ''
              ? `id:${rawEntryId}`
              : `ca:${latest.created_at}`;

          const prevEntryKey =
            lastFeedEntryKeyRef.current;

          const entryChanged =
            prevEntryKey !== null &&
            entryKey !== prevEntryKey;

          const wallMsSinceNewEntry =
            Date.now() -
            lastNewEntryWallMsRef.current;

          const wallSaysStale =
            prevEntryKey !== null &&
            !entryChanged &&
            wallMsSinceNewEntry >=
              ESP32_NO_NEW_ENTRY_MS;

          const tsSaysLive =
            numsOk &&
            sampleAgeSec <= ESP32_TS_ONLINE_SEC;

          const tsSaysDead =
            numsOk &&
            sampleAgeSec >= ESP32_TS_OFFLINE_SEC;

          const activityBurst =
            numsOk &&
            entryChanged &&
            sampleAgeSec <= 24;

          let esp32Online = false;

          if (!numsOk) {

            esp32Online = false;
          } else if (wallSaysStale || tsSaysDead) {

            esp32Online = false;
          } else if (
            tsSaysLive ||
            activityBurst
          ) {

            esp32Online = true;
          } else {

            esp32Online =
              esp32StableOnlineRef.current;
          }

          esp32StableOnlineRef.current =
            esp32Online;

          if (entryChanged) {

            lastNewEntryWallMsRef.current =
              Date.now();
          }

          if (prevEntryKey === null) {

            lastNewEntryWallMsRef.current =
              Date.now();
          }

          lastFeedEntryKeyRef.current =
            entryKey;

          setLastUpdated(
            createdAt.toLocaleTimeString()
          );

          if (esp32Online) {

            sensorOfflineSent.current = false;

            setConnected(true);

            setSensorActive(true);

            setTemperature(temp);

            setHumidity(hum);

            setStatus('LIVE SENSOR STREAM');

            if (
              !sensorOnlineSent.current
            ) {

              sendNotification(
                '✅ SENSOR CONNECTED',
                'ESP32 monitoring system is active.'
              );

              sensorOnlineSent.current = true;
            }

            /* =======================================================
               TEMPERATURE ALERT
               MAX SAFE LIMIT = 28°C
            ======================================================= */

            if (
              tempNum >= 28 &&
              !tempAlertSent.current
            ) {

              sendNotification(
                '🚨 SERVER ROOM OVERHEATING',
                `Temperature reached ${tempNum}°C`
              );

              tempAlertSent.current = true;
            }

            if (tempNum < 28) {

              tempAlertSent.current = false;
            }

            /* =======================================================
               LOW HUMIDITY ALERT
            ======================================================= */

            if (
              humNum < 40 &&
              !lowHumAlertSent.current
            ) {

              sendNotification(
                '⚠ LOW HUMIDITY WARNING',
                `Humidity dropped to ${humNum}%`
              );

              lowHumAlertSent.current = true;
            }

            /* =======================================================
               HIGH HUMIDITY ALERT
            ======================================================= */

            if (
              humNum > 60 &&
              !highHumAlertSent.current
            ) {

              sendNotification(
                '🚨 HIGH HUMIDITY ALERT',
                `Humidity reached ${humNum}%`
              );

              highHumAlertSent.current = true;
            }

            if (humNum >= 40) {

              lowHumAlertSent.current = false;
            }

            if (humNum <= 60) {

              highHumAlertSent.current = false;
            }

            setTempHistory(prev => {

              const updated =
                [...prev, tempNum]
                  .slice(-10);

              const average =
                updated.reduce(
                  (a, b) => a + b,
                  0
                ) / updated.length;

              setAvgTemp(average);

              return updated;
            });

            setHumHistory(prev => {

              const updated =
                [...prev, humNum]
                  .slice(-10);

              const average =
                updated.reduce(
                  (a, b) => a + b,
                  0
                ) / updated.length;

              setAvgHum(average);

              return updated;
            });

            setTimeLabels(prev => {

              const currentTime =
                new Date()
                  .toLocaleTimeString(
                    [],
                    {
                      hour: '2-digit',
                      minute: '2-digit',
                    }
                  );

              return [
                ...prev,
                currentTime,
              ].slice(-10);
            });
          } else if (numsOk) {

            setConnected(false);

            setSensorActive(false);

            setTemperature(temp);

            setHumidity(hum);

            setStatus(
              'ESP32 OFFLINE · STALE LAST READ'
            );

            if (
              !sensorOfflineSent.current
            ) {

              sendNotification(
                '❌ SENSOR OFFLINE',
                'ESP32 stopped sending data.'
              );

              sensorOfflineSent.current = true;

              sensorOnlineSent.current = false;
            }
          } else {

            setSensorActive(false);

            setConnected(false);

            setStatus('SENSOR STOPPED');

            if (
              !sensorOfflineSent.current
            ) {

              sendNotification(
                '❌ SENSOR OFFLINE',
                'ESP32 stopped sending data.'
              );

              setTemperature('----');

              setHumidity('----');

              sensorOfflineSent.current = true;

              sensorOnlineSent.current = false;
            }
          }
        } else {

          esp32StableOnlineRef.current = false;

          lastFeedEntryKeyRef.current = null;

          setConnected(false);
          setSensorActive(false);
          setStatus('THINGSPEAK NO DATA');

          if (!sensorOfflineSent.current) {
            sendNotification(
              '❌ SENSOR OFFLINE',
              'ESP32 stopped sending data.'
            );

            setTemperature('----');
            setHumidity('----');

            sensorOfflineSent.current = true;
            sensorOnlineSent.current = false;
          }
        }

      } catch (error) {

        console.log(error);

        esp32StableOnlineRef.current = false;

        lastFeedEntryKeyRef.current = null;

        setConnected(false);

        setSensorActive(false);

        setStatus(
          'THINGSPEAK DISCONNECTED'
        );

        if (
          !sensorOfflineSent.current
        ) {

          sendNotification(
            '⚠ CONNECTION ERROR',
            'ThingSpeak connection failed.'
          );

          setTemperature('----');

          setHumidity('----');

          sensorOfflineSent.current = true;

          sensorOnlineSent.current = false;
        }
      }
    };

  /* =======================================================
     UI
  ======================================================= */

  return (

    <SafeAreaView
      style={styles.container}
    >

      <StatusBar
        barStyle="light-content"
      />

      <LinearGradient
        colors={[
          '#050A14',
          '#071426',
          '#050A14',
        ]}
        style={styles.background}
      >

        <ScrollView
          showsVerticalScrollIndicator={false}
        >

          {/* HEADER */}

          <View style={styles.header}>

            <View>

              <Text style={styles.title}>
                ThermoNode
              </Text>

              <Text style={styles.subtitle}>
                SMART SERVER ROOM MONITOR
              </Text>

            </View>

            <View
              style={[
                styles.liveBadge,
                {
                  borderColor: connected
                    ? 'rgba(0,255,136,0.4)'
                    : 'rgba(255,59,48,0.45)',
                },
              ]}
            >

              <View
                style={[
                  styles.liveDot,
                  {
                    backgroundColor: connected
                      ? '#00FF88'
                      : '#FF3B30',
                  },
                ]}
              />

              <Text
                style={[
                  styles.liveText,
                  {
                    color: connected
                      ? '#00FF88'
                      : '#FF3B30',
                  },
                ]}
              >
                {connected
                  ? 'CONNECTED'
                  : 'OFFLINE'}
              </Text>

            </View>

          </View>

          {/* SENSOR CARDS */}

          <View style={styles.cardRow}>

            <View style={styles.card}>

              <View style={styles.iconContainer}>

                <Ionicons
                  name="thermometer-outline"
                  size={24}
                  color="#FF6B35"
                />

              </View>

              <Text style={styles.cardLabel}>
                TEMPERATURE
              </Text>

              <Text
                style={[
                  styles.reading,
                  { color: '#FF6B35' },
                ]}
              >
                {temperature}
              </Text>

              <Text style={styles.unit}>
                °C
              </Text>

            </View>

            <View style={styles.card}>

              <View style={styles.iconContainer}>

                <Ionicons
                  name="water-outline"
                  size={24}
                  color="#00D4FF"
                />

              </View>

              <Text style={styles.cardLabel}>
                HUMIDITY
              </Text>

              <Text
                style={[
                  styles.reading,
                  { color: '#00D4FF' },
                ]}
              >
                {humidity}
              </Text>

              <Text style={styles.unit}>
                %RH
              </Text>

            </View>

          </View>

          {/* STATUS */}

          <View style={styles.statusCard}>

            <View style={styles.statusTop}>

              <Ionicons
                name={
                  sensorActive
                    ? 'hardware-chip-outline'
                    : 'pause-circle-outline'
                }
                size={24}
                color={
                  sensorActive ? '#00FF88' : '#FF3B30'
                }
              />

              <View
                style={{
                  marginLeft: 12,
                  flex: 1,
                }}
              >

                <Text style={styles.statusTitle}>
                  {status}
                </Text>

                <Text style={styles.statusSubtext}>
                  LAST UPDATED :
                  {' '}
                  {lastUpdated}
                </Text>

              </View>

              {!sensorActive && (
                <ActivityIndicator
                  size="small"
                  color="#00D4FF"
                />
              )}

            </View>

          </View>

          {/* AVG CHARTS */}

          <View style={styles.avgContainer}>

            <View style={styles.avgCard}>

              <Text style={styles.avgTitle}>
                AVG TEMP
              </Text>

              <ProgressChart
                data={{
                  labels: [''],
                  data: [
                    avgTemp > 0
                      ? avgTemp / 50
                      : 0.01,
                  ],
                }}
                width={140}
                height={140}
                strokeWidth={10}
                radius={32}
                hideLegend
                chartConfig={{
                  backgroundGradientFrom:
                    '#071426',
                  backgroundGradientTo:
                    '#071426',
                  color: () => '#FF6B35',
                }}
              />

              <Text style={styles.avgValue}>
                {avgTemp.toFixed(1)}°C
              </Text>

            </View>

            <View style={styles.avgCard}>

              <Text style={styles.avgTitle}>
                AVG HUM
              </Text>

              <ProgressChart
                data={{
                  labels: [''],
                  data: [
                    avgHum > 0
                      ? avgHum / 100
                      : 0.01,
                  ],
                }}
                width={140}
                height={140}
                strokeWidth={10}
                radius={32}
                hideLegend
                chartConfig={{
                  backgroundGradientFrom:
                    '#071426',
                  backgroundGradientTo:
                    '#071426',
                  color: () => '#00D4FF',
                }}
              />

              <Text style={styles.avgValue}>
                {avgHum.toFixed(1)}%
              </Text>

            </View>

          </View>

          {/* TEMP GRAPH */}

          {tempHistory.length > 0 && (

            <View style={styles.graphCard}>

              <Text style={styles.graphTitle}>
                TEMPERATURE TREND
              </Text>

              <LineChart
                data={{
                  labels:
                    timeLabels.length > 0
                      ? timeLabels
                      : ['--'],
                  datasets: [
                    {
                      data: tempHistory,
                    },
                  ],
                }}
                width={screenWidth - 40}
                height={220}
                yAxisSuffix="°"
                bezier
                chartConfig={{
                  backgroundGradientFrom:
                    '#071426',
                  backgroundGradientTo:
                    '#071426',
                  decimalPlaces: 1,
                  color: (
                    opacity = 1
                  ) =>
                    `rgba(255,107,53,${opacity})`,
                  labelColor: () =>
                    '#94A3B8',
                }}
                style={styles.chart}
              />

            </View>

          )}

          {/* HUM GRAPH */}

          {humHistory.length > 0 && (

            <View style={styles.graphCard}>

              <Text style={styles.graphTitle}>
                HUMIDITY TREND
              </Text>

              <LineChart
                data={{
                  labels:
                    timeLabels.length > 0
                      ? timeLabels
                      : ['--'],
                  datasets: [
                    {
                      data: humHistory,
                    },
                  ],
                }}
                width={screenWidth - 40}
                height={220}
                yAxisSuffix="%"
                bezier
                chartConfig={{
                  backgroundGradientFrom:
                    '#071426',
                  backgroundGradientTo:
                    '#071426',
                  decimalPlaces: 1,
                  color: (
                    opacity = 1
                  ) =>
                    `rgba(0,212,255,${opacity})`,
                  labelColor: () =>
                    '#94A3B8',
                }}
                style={styles.chart}
              />

            </View>

          )}

        </ScrollView>

      </LinearGradient>

    </SafeAreaView>
  );
}

const styles = StyleSheet.create({

  container: {
    flex: 1,
    backgroundColor: '#050A14',
  },

  background: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 20,
  },

  header: {
    flexDirection: 'row',
    justifyContent:
      'space-between',
    alignItems: 'center',
    marginBottom: 30,
  },

  title: {
    color: '#E8F4FF',
    fontSize: 28,
    fontWeight: '800',
  },

  subtitle: {
    color: '#94A3B8',
    fontSize: 11,
    marginTop: 4,
    letterSpacing: 1,
  },

  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor:
      'rgba(255,255,255,0.03)',
  },

  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 10,
    marginRight: 6,
  },

  liveText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
  },

  cardRow: {
    flexDirection: 'row',
    justifyContent:
      'space-between',
    marginBottom: 20,
  },

  card: {
    width: '48%',
    backgroundColor:
      'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor:
      'rgba(0,212,255,0.15)',
    borderRadius: 18,
    padding: 18,
    alignItems: 'center',
  },

  iconContainer: {
    width: 46,
    height: 46,
    borderRadius: 14,
    backgroundColor:
      'rgba(255,255,255,0.04)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 14,
  },

  cardLabel: {
    color: '#94A3B8',
    fontSize: 11,
    marginBottom: 14,
    letterSpacing: 1,
  },

  reading: {
    fontSize: 42,
    fontWeight: '800',
  },

  unit: {
    color: '#94A3B8',
    marginTop: 4,
  },

  statusCard: {
    backgroundColor:
      'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor:
      'rgba(0,212,255,0.15)',
    borderRadius: 18,
    padding: 18,
    marginBottom: 20,
  },

  statusTop: {
    flexDirection: 'row',
    alignItems: 'center',
  },

  statusTitle: {
    color: '#E8F4FF',
    fontSize: 15,
    fontWeight: '700',
  },

  statusSubtext: {
    color: '#94A3B8',
    fontSize: 11,
    marginTop: 4,
  },

  avgContainer: {
    flexDirection: 'row',
    justifyContent:
      'space-between',
    marginBottom: 20,
  },

  avgCard: {
    width: '48%',
    backgroundColor:
      'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor:
      'rgba(0,212,255,0.15)',
    borderRadius: 18,
    padding: 10,
    alignItems: 'center',
  },

  avgTitle: {
    color: '#94A3B8',
    fontSize: 11,
    marginBottom: 10,
  },

  avgValue: {
    color: '#E8F4FF',
    fontSize: 20,
    fontWeight: '700',
    marginTop: -20,
  },

  graphCard: {
    backgroundColor:
      'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor:
      'rgba(0,212,255,0.15)',
    borderRadius: 18,
    padding: 14,
    marginBottom: 20,
  },

  graphTitle: {
    color: '#E8F4FF',
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 10,
  },

  chart: {
    borderRadius: 16,
  },

});