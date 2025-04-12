require('dotenv').config();
const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
const sqlite3 = require('sqlite3').verbose();
const QRCode = require('qrcode');

const app = express();
const port = process.env.PORT || 3001;

// Configuração do CORS
const corsOptions = {
    origin: process.env.FRONTEND_URL,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(express.json());
// Nova rota para obter o status do sistema
app.get('/status', (req, res) => {
    res.json({ ativo: sistemaAtivo });
  });
// Inicializar o cliente Twilio
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
const client = twilio(accountSid, authToken);

// Banco de dados SQLite
const db = new sqlite3.Database('senhas.db', (err) => {
    if (err) {
        console.error("Erro ao abrir o banco de dados:", err.message);
    } else {
        console.log('Conectado ao banco de dados SQLite.');
        db.run(`CREATE TABLE IF NOT EXISTS motoristas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nome TEXT NOT NULL,
            telefone TEXT NOT NULL,
            placa TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            chamado INTEGER DEFAULT 0  -- Novo campo: 0 = não chamado, 1 = chamado
        )`, (err) => {
            if (err) {
                console.error("Erro ao criar a tabela:", err.message);
            } else {
                console.log('Tabela de motoristas criada ou já existente.');
            }
        });
    }
});

// Variável para controlar o status do sistema
let sistemaAtivo = false;

// Middleware para verificar se o sistema está ativo
const sistemaAtivoMiddleware = (req, res, next) => {
    if (!sistemaAtivo && req.path !== '/ativar-sistema' && req.path !== '/desativar-sistema' && req.path !== '/status' && req.method !== 'GET') {
        return res.status(403).send('Sistema desativado. Ative-o para continuar.');
    }
    next();
};

// Aplica o middleware a todas as rotas (exceto as rotas de ativação e desativação do sistema)
app.use(sistemaAtivoMiddleware);

// Rota para ativar o sistema
app.post('/ativar-sistema', (req, res) => {
    sistemaAtivo = true;
    console.log('Sistema ativado.');
    res.send('Sistema ativado com sucesso!');
});

// Rota para desativar o sistema
app.post('/desativar-sistema', (req, res) => {
    sistemaAtivo = false;
    console.log('Sistema desativado.');
    res.send('Sistema desativado com sucesso!');
});

// Nova rota para obter o status do sistema
app.get('/status', (req, res) => {
  res.json({ ativo: sistemaAtivo });
});

// Rota para geração do QR Code
app.get('/qrcode', async (req, res) => {
    const url = `${process.env.FRONTEND_URL}?modo=motorista`; // Adicionar o parâmetro
    try {
        const qrCodeDataURL = await QRCode.toDataURL(url);
        res.json({ qrCode: qrCodeDataURL });
    } catch (err) {
        console.error("Erro ao gerar o QR Code:", err);
        res.status(500).send('Erro ao gerar o QR Code.');
    }
});

// Rota para cadastrar motorista
app.post('/cadastrar', (req, res) => {
    const { nome, telefone, placa } = req.body;
    if (!nome || !telefone || !placa) {
        return res.status(400).send('Nome, telefone e placa são obrigatórios.');
    }

    // Inserir os dados no banco de dados
    const sql = 'INSERT INTO motoristas (nome, telefone, placa) VALUES (?, ?, ?)';
    db.run(sql, [nome, telefone, placa], function(err) {
        if (err) {
            console.error("Erro ao inserir motorista:", err.message);
            return res.status(500).send('Erro ao cadastrar motorista.');
        }
        console.log(`Motorista cadastrado com ID: ${this.lastID}`);
        res.json({ message: 'Motorista cadastrado com sucesso!', id: this.lastID });
    });
});

// Rota para chamar o próximo motorista
app.post('/chamar-proximo', (req, res) => {
  db.get('SELECT id, nome, telefone FROM motoristas WHERE chamado = 0 ORDER BY timestamp ASC LIMIT 1', (err, motorista) => {
      if (err) {
          console.error("Erro ao buscar motorista:", err.message);
          return res.status(500).send('Erro ao buscar motorista.');
      }

      if (!motorista) {
          return res.status(404).send('Nenhum motorista na fila.');
      }

      // Enviar SMS usando Twilio
      client.messages
          .create({
              body: `Olá ${motorista.nome}, sua vez chegou!`,
              from: twilioPhoneNumber,
              to: motorista.telefone
          })
          .then(() => {
              console.log(`SMS enviado para ${motorista.nome} (${motorista.telefone}).`);

              // Atualizar o status do motorista para "chamado"
              db.run('UPDATE motoristas SET chamado = 1 WHERE id = ?', motorista.id, (err) => {
                  if (err) {
                      console.error("Erro ao atualizar motorista:", err.message);
                      return res.status(500).send('Erro ao atualizar motorista.');
                  }
                  console.log(`Motorista ${motorista.nome} marcado como chamado.`);
                  res.send('Motorista notificado e atualizado na fila.');
              });
          })
          .catch(error => {
              console.error("Erro ao enviar SMS:", error);
              res.status(500).send('Erro ao enviar SMS.');
          });
  });
});

// Rota para chamar um motorista novamente
app.post('/chamar-novamente/:id', (req, res) => {
  const motoristaId = req.params.id;

  db.get('SELECT id, nome, telefone FROM motoristas WHERE id = ?', motoristaId, (err, motorista) => {
      if (err) {
          console.error("Erro ao buscar motorista:", err.message);
          return res.status(500).send('Erro ao buscar motorista.');
      }

      if (!motorista) {
          return res.status(404).send('Motorista não encontrado.');
      }

      // Enviar SMS novamente usando Twilio
      client.messages
          .create({
              body: `Olá ${motorista.nome}, estamos chamando novamente! Por favor, compareça.`,
              from: twilioPhoneNumber,
              to: motorista.telefone
          })
          .then(() => {
              console.log(`SMS reenviado para ${motorista.nome} (${motorista.telefone}).`);
              res.send('Motorista notificado novamente.');
          })
          .catch(error => {
              console.error("Erro ao enviar SMS:", error);
              res.status(500).send('Erro ao enviar SMS.');
          });
  });
});

// Rota para remover o motorista da fila
app.delete('/motoristas/:id', (req, res) => {
  const motoristaId = req.params.id;

  db.run('DELETE FROM motoristas WHERE id = ?', motoristaId, (err) => {
      if (err) {
          console.error("Erro ao remover motorista:", err.message);
          return res.status(500).send('Erro ao remover motorista.');
      }
      console.log(`Motorista com ID ${motoristaId} removido da fila.`);
      res.send('Motorista removido da fila com sucesso!');
  });
});

// Rota para listar os motoristas na fila
app.get('/motoristas', (req, res) => {
    db.all('SELECT id, nome, placa, timestamp, chamado FROM motoristas ORDER BY timestamp ASC', [], (err, motoristas) => {
        if (err) {
            console.error("Erro ao listar motoristas:", err.message);
            return res.status(500).send('Erro ao listar motoristas.');
        }
        res.json(motoristas);
    });
});

// Rota para resetar a fila de motoristas
app.post('/resetar-fila', (req, res) => {
    db.run('DELETE FROM motoristas', (err) => {
        if (err) {
            console.error("Erro ao resetar a fila:", err.message);
            return res.status(500).send('Erro ao resetar a fila.');
        }
        console.log('Fila de motoristas resetada.');
        res.send('Fila de motoristas resetada com sucesso!');
    });
});

// Iniciar o servidor
app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});