import {useState} from 'react';
import { FlatList, Text, View, StyleSheet, Button, Pressable } from 'react-native';
import { Audio,AVPlaybackStatus } from 'expo-av';
import { Recording, Sound } from 'expo-av/build/Audio';
import RecordListItem from '@/components/sunet/recordListItem';
import * as DocumentPicker from 'expo-document-picker';
import { useSharedValue } from 'react-native-reanimated';
import { SoundRecording } from '@/components/sunet/recordListItem';


export default function Sunet() {
  //Vom utiliza un Hook numit useState, cu ajutorul caruia React va retine in memorie starea unei componente.
  //In cazul nostru, recording este variabila constanta a carei stare trebuie retinuta, iar setRecording este functia prin carea modificam variabila recording. 
  const [recording, setRecording] = useState<Recording>();
  const [recordList, setRecordList] = useState<SoundRecording[]>([]); //vector in care vom pastra calea catre toate inregistrarile audio
  const [permissionResponse, requestPermission] = Audio.usePermissions();
  const [activeSound, setActiveSound] = useState<Sound | null>(null);
  const [isPaused, setIsPaused] = useState(false);  // verificam daca in timpul inregistrarii am pus pauza
  
  const [selectedReplays, setSelectedReplays] = useState<string[]>([]);

  const[audioMetering,setAudioMetering] = useState<number[]>([]); 
  const metering = useSharedValue(-100);  // valoarea initiala pentru variabila in care sunt retinute intensitatile sunetului achizitionat

  async function skipBackward() {
    if (!activeSound) 
      return;

    const status = await activeSound.getStatusAsync();
    if (!status.isLoaded) 
      return;

    let newPosition = status.positionMillis - 1000;
    if (newPosition < 0) 
      newPosition = 0;

    await activeSound.setPositionAsync(newPosition);
  }

  async function skipForward() {
    if (!activeSound) 
      return;

    const status = await activeSound.getStatusAsync();
    if (!status.isLoaded || !status.durationMillis) 
      return;

    let newPosition = status.positionMillis + 1000;
    if (newPosition > status.durationMillis) 
      newPosition = status.durationMillis;

    await activeSound.setPositionAsync(newPosition);
  }

  async function startRecording() {
    try {
      setAudioMetering([])

      if (permissionResponse?.status !== 'granted') {  // cerem permisiunea pentru a utiliza microfonul
        console.log('Requesting permission..');
        await requestPermission();
      }
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      }); 

      console.log('Starting recording..');
       // incepem inregistrarea si setam calitatea acesteia
      const { recording } = await Audio.Recording.createAsync( 
      // Atentie in cadrul funtiei startRecording(), variabila recording este locala, fiind extrasa din raspunsul pe care il returneaza Audio.Recording.createAsync.
      // Asadar, aceasta variabila locala nu trebuie confundata cu variabila pentru care utilizam memoria interna a React-ului.  
        Audio.RecordingOptionsPresets.HIGH_QUALITY,
        undefined,
        100  
      );
      setRecording(recording);  // modificam continutul variabilei recording pentru a prelua sunetul care este captat de la microfon
      setIsPaused(false); // Resetam variabila care verifica daca punem pauza in timpul intregistrarii atunci cand incepem o noua inregistrare.
      console.log('Recording started');

      recording.setOnRecordingStatusUpdate((status) =>{
        //console.log(status.metering);  //sunetul preluat de la microfon exprimat in decibeli
        if(status.metering){
          metering.value = status.metering 
          setAudioMetering((curVal) =>[...curVal, status.metering || -100])
        }
      })
    } catch (err) {
      console.error('Failed to start recording', err);
    }
  }

  async function pauseRecording() {   // functie pentru a pune pauza inregistrarii curente
    if (!recording) return;
    try {
      console.log('Pausing recording...');
      await recording.pauseAsync();
      setIsPaused(true);
    } catch (err) {
      console.error('Failed to pause recording', err);
    }
  }

  async function resumeRecording() {  //functie pentru a relua inregistrarea audio pusa anterior pe pauza
    if (!recording) return;
    try {
      console.log('Resuming recording...');
      await recording.startAsync(); 
      setIsPaused(false);
    } catch (err) {
      console.error('Failed to resume recording', err);
    }
  }

  async function stopRecording() {
    if (!recording){  
      // utilizat pentru a nu avea erori de executie in cazul in care butonul stop este apasat inainte ca inregistrarea sa inceapa
      return; 
    }
    console.log('Stopping recording..');
    setRecording(undefined);  // modificam continutul variabilei recording pentru ca nu mai preluam sunetul intregistrat de la microfon 
    setIsPaused(false); // Resetam variabila care verifica daca punem pauza in timpul intregistrarii, dupa ce terminam de achizitionat sunetul.
    await recording.stopAndUnloadAsync(); // oprim inregistrarea sunetului si eliberam spatiul alocat din memorie 
    await Audio.setAudioModeAsync(
    {
      allowsRecordingIOS: false,
    }); 
    const uri = recording.getURI(); // salvam intr-o variabila URI-ul inregistrarii, pentru a putea sa o redam mai tarziu.
    console.log('Recording stopped and stored at', uri);
    metering.value = -160
    if(uri){
      setRecordList((existingRecords) => [{uri, metering: audioMetering},... existingRecords]);  // punem URI-ul la inceputul vectorului cu URI-uri existente
      
    }
  }

  async function pickAudioFile() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'audio/*',
        copyToCacheDirectory: true,
      });
  
      if (result.assets && result.assets.length > 0) {
        const uri = result.assets[0].uri;
        console.log('Selected file:', uri);
        setRecordList((prevList) => [{uri, metering: audioMetering}, ...prevList]); // Add to record list
      }
    } catch (error) {
      console.error('Error picking file:', error);
    }
  }
  
  return (
    <View style={styles.container}>
      <FlatList 
        data = {recordList}
        renderItem={({item}) => <RecordListItem rec={item} onSoundLoaded={setActiveSound} selectedReplays={selectedReplays} 
        setSelectedReplays={setSelectedReplays}  /> }  // Trimitem fiecare URI catre RecorListItem  
      />

      <View style={styles.footer}>
        {/*Daca nu inregistrarm sunetul, vom avea disponibil doar butonul care porneste inregistrarea audio.
         In caz contrar, avem disponibil atat butonul pentru a pune pauza si de a relua inregistrarea, cat si butonul pentru a opri inregistrarea.*/}
      {!recording ? (
      <Pressable
        style={[styles.recordButton, {width: recording ? 50 : 60}, {borderRadius: recording ? 5 : 35}]}
        onPress={recording ? stopRecording : startRecording}
      />
      ) : (
      <View style={styles.controlButtons}>
        <Button title={isPaused ? 'Resume' : 'Pause'} onPress={isPaused ? resumeRecording : pauseRecording} />
        <Pressable
          style={[styles.recordButton, {width: recording ? 50 : 60}, {borderRadius: recording ? 5 : 35}]}
          onPress={recording ? stopRecording : startRecording}
        />
      </View>
      )}
      <View style={styles.skipButtonsContainer}>
        <Button title="-1s" onPress={skipBackward} />
        <Text>  </Text>
        <Button title="Alege audio" onPress={pickAudioFile} />
        <Text>  </Text>
        <Button title="+1s" onPress={skipForward} />
      </View>
      </View>
      
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    backgroundColor: '#ecf0f1',
    
  },
  footer :{
    backgroundColor: 'white',
    height: 120,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordButton :{
    backgroundColor: 'orangered',
    aspectRatio: 1,
    borderRadius: 30,

    borderWidth: 3,
    borderColor: 'gray', 
  },
  skipButtonsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    width: 200,
    marginTop: 10,
  },
  controlButtons: { 
    flexDirection: 'row', // Ensures buttons appear in a row
    alignItems: 'center',
    gap: 10, // Adds spacing between buttons
  },
});
