import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
export default function Layout() {
  return <GestureHandlerRootView style={{ flex: 1 }}><SafeAreaProvider><KeyboardProvider>
    <StatusBar style="light" /><Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#090b0e' }, animation: 'none' }} />
  </KeyboardProvider></SafeAreaProvider></GestureHandlerRootView>;
}
