import { View, Text, StyleSheet } from 'react-native'
import { FontAwesome5 } from '@expo/vector-icons'
import {useState, useEffect} from 'react'
import {Audio, AVPlaybackStatus} from 'expo-av'
import {Sound} from 'expo-av/build/Audio'
import Checkbox from 'expo-checkbox';
import { Extrapolation, interpolate } from 'react-native-reanimated'

export type SoundRecording = {
  uri: string
  metering: number[]
}

const RecordListItem = ({
  rec,
  onSoundLoaded,
  selectedReplays,
  setSelectedReplays 
} : {
  rec:SoundRecording; 
  onSoundLoaded: (sound: Sound) => void; 
  selectedReplays: string[]; 
  setSelectedReplays: React.Dispatch<React.SetStateAction<string[]>> 
}) => {

  const [sound, setSound] = useState<Sound>(); //tipul acestui useState este Sound
  const [status, setStatus] = useState<AVPlaybackStatus>()
  const [isChecked, setChecked] = useState(false);

  async function loadSound(){
    console.log('Loading Sound');
    //  {progressUpdateIntervalMillis: 1000/60} este utilizat pentru a apela onPlaybackStatusUpdate de 60 de ori pe secunda. 
    const { sound } = await Audio.Sound.createAsync({uri: rec.uri}, {shouldPlay: false, progressUpdateIntervalMillis: 1000/60}, onPlaybackStatusUpdate);  // incarca (load) sunetul de la adresa URI pentru a fi redat
    setSound(sound);

    //sound.setOnAudioSampleReceived((sample) => console.log(JSON.stringify(sample,null,2)))

  }

  useEffect(() =>{   //cand apare un URI nou este apelata functia loadSound
    loadSound();
  }, [rec])

  async function onPlaybackStatusUpdate(newStatus: AVPlaybackStatus){ // functie care returneaza detalii despre intregistrarea in curs de redare
    //console.log(JSON.stringify(newStatus,null,2))  //JSON.stringify este utilizat pentru a afisa frumos informatiile despre inregistrare in consola
    setStatus(newStatus)
  
    if(!sound){
      return;
    }
    if (newStatus.isLoaded && newStatus.didJustFinish){
      newStatus.positionMillis = 0;
      setStatus(newStatus)
      await sound?.setPositionAsync(0)
      // dupa ce terminam de redat o inregistrare trebuie sa resetam pozitia inregistrarii la milisecunda 0. 
      // astfel putem sa ascultam din nou inregistrarea in cazul in care dorim 
       
    }
  }

  async function playSound() {  
    if(!sound){
        return;
    }
    // Daca sunetul nu este selectat in CheckBox, acesta nu va fi redat 
    if (!selectedReplays.includes(rec.uri)) {
      console.log("This recording is not selected. Ignoring play request.");
      return;
    }

    console.log('Playing Sound'); 
    if(status?.isLoaded && status.didJustFinish){
      await sound.replayAsync();
      onSoundLoaded(sound);
    }
    if(status?.isLoaded && status.isPlaying){
      await sound.pauseAsync();
    }else{
      await sound.playAsync(); //reda sunetul
      onSoundLoaded(sound);
    } 
      
  }

  // folosim acest useEffect care este apelat de fiecare data cand sound isi modifica continutul pentru a elibera memorie
  useEffect(() => {
    return sound
      ? () => {
          console.log('Unloading Sound');
          sound.unloadAsync();
        }
      : undefined;
  }, [sound]);  

  const millisToSecond = (millis: number) => {    // functie utilizata pentru a afisa dimensiunea inregistrarii sub forma 'minute:secunde'
    const minutes = Math.floor(millis /(1000 * 60))
    const seconds = Math.floor(millis %(1000 * 60)/ 1000)

    return `${minutes}:${seconds <10 ? '0' : ''}${seconds}`
  }

  const isPlaying = status?.isLoaded ? status.isPlaying : false
  const currentPosition = status?.isLoaded ? status.positionMillis : 0  //pozitia initializata cu 0
  const duration = status?.isLoaded && status.durationMillis ? status.durationMillis : 1 //durata initializata cu 1
  const progress = currentPosition / duration; // variabila utilizata pentru pozitionarea indicatorului de progresul in timpul redarii audio 

  //console.log(rec)

  let lines = [];
  let numLines = 35;  // numar predefinit de linii pentru toate inregistrarile in reprezentarea de "waveform"

  for (let i = 0; i < numLines; i++){
    const meteringIndex = Math.floor((i * rec.metering.length) / numLines)
    const nextMeteringIndex = Math.ceil(((i+1) * rec.metering.length) / numLines)
    const values = rec.metering.slice(meteringIndex, nextMeteringIndex) 
    const average = values.reduce((sum, a) => sum +a, 0) / values.length
    lines.push(average);
  }

  rec.metering.forEach((db, index)=>{}); 

  // iconitele pentru play si pause sunt specifice FontAwesome5
  return (
    <View style={styles.containter}>
      <Checkbox
        value={selectedReplays.includes(rec.uri)}
        onValueChange={() => {
          setSelectedReplays((prevSelected) =>
            prevSelected.includes(rec.uri)
              ? prevSelected.filter((item) => item !== rec.uri) // elimina inregistrarea din lista de inregistrari ce trebuie redate
              : [...prevSelected, rec.uri] // adauga inregistrarea in lista de inregistrari ce trebuie redate
          );
        }}
        color={selectedReplays.includes(rec.uri) ? 'blue' : undefined} 
      />
          
      <FontAwesome5 onPress={playSound} name={isPlaying ? 'pause' : 'play'} size={20} color={'gray'}/>  
      <View style={styles.playbackContainer}>
        <View style={styles.wave}>
          {lines.map((db, index) => (
            <View
              key = {index} 
              style={[ 
                styles.waveLine, 
                {
                  height: interpolate(db, [-160, 0],[5, 50], Extrapolation.CLAMP),  // Extrapolation.CLAMP este utilizat pentru ca valorile ce depasesc intervalul initial [-160, 0] sa fie trunchiate in interiorul intervalului [5,50]
                  backgroundColor: progress > index / lines.length ? 'royalblue' : 'gainsboro'
                 },
              ]}
            />
          ))}
          </View>
        <View style={[styles.playbackIndicator, {left: `${progress * 100}%`}]}></View>  
        {/* proprietatea left este utilizata pentru a putea pozitiona indicatorul de progres in functie de procentul din inregistrare care a fost parcurs */}

        <Text style={{position: 'absolute', right: 0, bottom: 0, color:'gray'}}>{millisToSecond(currentPosition || 0)}/{status?.isLoaded && status.durationMillis ? (millisToSecond(status.durationMillis || 0)) : 'Loading..' }</Text>
        {/* afisam durata inregistrarii */}
      </View> 
    </View>
  )
}

const styles = StyleSheet.create({
    containter:{
        backgroundColor: 'white',
        margin:5,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 15,
        borderRadius: 10,
        gap: 15,
    },
    playbackContainer:{
        flex: 1,
        height: 60,
        justifyContent: 'center',
    },
    playbackBackground:{
        height: 3,
        backgroundColor: 'gainsboro',
        borderRadius: 5,
    },
    playbackIndicator:{
        width: 10,
        aspectRatio: 1,
        borderRadius: 10,
        backgroundColor: 'royalblue',
        position: 'absolute',
    },
    wave: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
    },
    waveLine: {
      flex: 1,
      
      backgroundColor: 'gainsboro',
      borderRadius: 10,
    }
})
export default RecordListItem