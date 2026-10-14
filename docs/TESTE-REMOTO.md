# Teste remoto: BASIC-ZB1GSP e MINI-ZB2GS

Roteiro de uns 30 minutos para quem testa em casa (Windows). O app grava um log com os detalhes e o
script `scripts/check-log.js` diz o que passou e o que falhou. Cada passo abaixo corresponde a uma
linha da saída do script.

## 1. Preparar

Na pasta do app, no PowerShell:

```powershell
git pull
npm install
homey app run -r 2>&1 | Tee-Object -FilePath teste.log
```

- A **primeira linha do app** no log deve ser `My Sonoff Devices v1.0.9 started (ZCL_DEBUG on)` (ou
  versão mais nova). Se não aparecer, o `git pull` não pegou a versão nova.
- Deixe o app subir por uns 5 minutos antes de começar (os primeiros minutos têm muito tráfego).
- Use um arquivo novo a cada rodada (`teste2.log`, `teste3.log`...).

## 2. BASIC-ZB1GSP

**Só na primeira vez com esta versão:** remova o BASIC do Homey e pareie de novo. Os reports de
potência e corrente só chegam sozinhos em aparelhos pareados com esta versão.

Use uma carga de **100 W ou mais** (ferro, secador, aquecedor). Lâmpada pequena não serve para ver
potência e corrente.

1. Ligue o relé pelo Homey, deixe uns 20 segundos e desligue. Faça 2 vezes. *(linhas "relay on and off" e "power read after on")*
2. Ligue o relé e deixe **3 minutos** com a carga. Olhe se potência, corrente e tensão mudam no app.
   *(linhas "reports on its own" e "energy total")*
3. Troque o limite de **corrente** para um valor **abaixo** da corrente da carga (por exemplo, 1 A
   para uma carga de 2 A) e ligue o relé. Ele deve desarmar sozinho em poucos segundos. Volte o limite
   para 32 A. *(linhas "protection limits written" e "relay opened by itself")*
4. Faça o mesmo com o limite de **tensão** (abaixo da tensão da tomada) e depois com o de **potência**
   (abaixo da carga). Volte os dois ao normal.
5. Mude o "Power-on behavior" uma vez.

Cada vez que você salvar um limite, o app lê de volta o que o aparelho guardou e o script compara com
o que foi gravado. *(linhas "written vs stored" e "extra attributes")* A linha "extra attributes"
mostra três coisas que o app ainda não usa: o bloco de limites (`0x7003`), o `outlet_control_protect`
(`0x7007`) e o `fault_code`. Elas ajudam a descobrir o que são os limites mínimos e o "Remote Unlock"
do aplicativo da Sonoff.

Anote: o relé desarmou nos 3 casos? Quanto tempo levou?

### 2b. BASIC-ZB1GSP: rodada complementar (alarme e flow de proteção)

Para quem já fez a seção 2. **Não precisa parear de novo.** Use a mesma carga de 100 W ou mais.

1. **Antes:** crie um flow com o gatilho **"Proteção desarmou"** do BASIC e a ação "Enviar notificação"
   com o texto `Desarmou: [Corrente] A, [Tensão] V, [Potência] W` (os três tokens do gatilho).
2. **Corrente:** limite de corrente abaixo da carga e ligue o relé. Quando desarmar, confira:
   - chegou a notificação, com uma corrente **acima** do limite;
   - no device, o alarme **"Overload protection"** ficou ativo.
   Ligue o relé de novo **pelo Homey**: o alarme deve **apagar** (e desarmar de novo, se o limite
   continuar baixo). Volte o limite para 32 A. *(linha "protection flow")*
3. **Tensão:** o mesmo com o limite de tensão abaixo da tensão da tomada. A notificação deve mostrar
   uma tensão **acima** do limite. Volte ao normal.
4. **Potência:** o mesmo com o limite de potência abaixo da carga. Volte ao normal.
5. **Energia:** deixe a carga ligada **15 minutos** sem mexer em nada. Anote no começo e no fim os
   valores de "Energia", "Energia hoje" e "Energia do mês" no app. *(linha "energy total")*
6. **Reports sozinhos:** durante esses 15 minutos, potência e corrente no app devem continuar mudando
   quando a carga muda (desligue e religue a carga **pela tomada dela**, não pelo relé). O app agora só
   consulta o aparelho a cada 10 minutos; o resto tem que vir do próprio aparelho. *(linha "reports on its own")*

Anote: a notificação chegou nas 3 vezes? O alarme apagou ao religar? Quanto a energia subiu em 15 min?

**Fora deste roteiro:** limites **mínimos** de corrente e tensão. O app ainda não tem essas opções;
falta descobrir o formato com uma captura do hub da Sonoff.

## 3. MINI-ZB2GS

1. **Canal 1:** ligue e desligue pelo Homey, 2 vezes. *(linha "gang 1 from Homey")*
2. **Canal 2:** o mesmo. *(linha "gang 2 from Homey")*
3. Aperte o **botão da parede** de cada canal, 1 vez cada. *(linhas "wall button")*
4. **Queda de energia:** tire o MINI-ZB2GS da energia (disjuntor) por uns 10 segundos e ligue de novo,
   **uma vez só**. Espere 1 minuto. Deve disparar o gatilho "Reconnected after power cut" nos dois
   canais e o contador da aba Rejoins deve subir 1. *(linha "power-cut trigger")*
5. Espere **pelo menos 1 minuto** depois do passo 4. Então mude uma configuração do canal 1 (modo da
   chave ou turbo). Isso **não** pode contar como queda de energia. *(linha "settings write is not a rejoin")*
6. Se você usa: configure um inching em um canal e dispare. *(linha "inching")*

## 4. Terminar e conferir

Pare o app com `Ctrl+C` e rode:

```powershell
node scripts/check-log.js teste.log
```

- Cole a saída do script na conversa. Ela não tem a chave da rede nem frames.
- **Não poste o `teste.log` em lugar público.** Com `ZCL_DEBUG` ligado o log pode ter dados de
  pareamento. Mande o arquivo só para o Gabriel.

### Como ler a saída

| Nível | Significa |
|---|---|
| PASS | passou |
| WARN | passo que falta fazer, ou algo a olhar (leia a frase) |
| FAIL | falhou: mande o log completo |
| INFO | só informação (versão, valores vistos) |

Um `FAIL` na linha `version` quer dizer que o log é de uma versão antiga do app.
