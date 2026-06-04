import { SlashCommandBuilder } from 'discord.js';
import fetch from 'node-fetch';
import generateGrid from '../utils/generateGrid.js';

export default {
  data: new SlashCommandBuilder()
    .setName('grid')
    .setDescription('Generate a Squigs grid from a wallet.')
    .addStringOption(option =>
      option.setName('wallet')
        .setDescription('Ethereum wallet address')
        .setRequired(true)),

  async execute(interaction) {
    const wallet = interaction.options.getString('wallet');
    await interaction.deferReply();

    const contractAddress = process.env.SQUIGS_CONTRACT.toLowerCase();
    const baseURL = `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`;

    try {
      const res = await fetch(`${baseURL}/getNFTs/?owner=${wallet}&contractAddresses[]=${contractAddress}`);
      const contentType = res.headers.get('content-type');

      if (!contentType || !contentType.includes('application/json')) {
        const text = await res.text();
        console.error('Alchemy returned non-JSON:', text);
        return interaction.editReply('Alchemy returned an error. Check logs.');
      }

      const data = await res.json();

      if (!data.ownedNfts || data.ownedNfts.length === 0) {
        return interaction.editReply('No Squigs found in that wallet.');
      }

      const tokenIds = data.ownedNfts.map(nft => parseInt(nft.id.tokenId, 16));
      const imageUrls = tokenIds.map(id =>
        `https://assets.bueno.art/images/a49527dc-149c-4cbc-9038-d4b0d1dbf0b2/default/${id}`
      );

      const buffer = await generateGrid(imageUrls);

      await interaction.editReply({
        content: `Here's your Squigs grid!`,
        files: [{ attachment: buffer, name: 'squigs-grid.png' }]
      });
    } catch (err) {
      console.error('Error in /squiggrid:', err);
      if (!interaction.replied) {
        await interaction.editReply('An error occurred while generating your Squigs grid.');
      }
    }
  }
};
